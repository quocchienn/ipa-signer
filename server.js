import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// === SỬA CHO TEST KHÔNG DISK ===
const DATA_DIR = process.env.RENDER_DISK_PATH || '/tmp';
const APPS_DIR = path.join(DATA_DIR, 'apps');

console.log(`📁 Using storage directory: ${APPS_DIR}`);

if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

app.use(express.static('public'));
app.use('/apps', express.static(APPS_DIR));

const upload = multer({ dest: '/tmp' });

// Lưu apps (dùng array trong memory + backup JSON trên disk)
let apps = [];
const APPS_JSON = path.join(DATA_DIR, 'apps.json');

if (fs.existsSync(APPS_JSON)) {
  apps = JSON.parse(fs.readFileSync(APPS_JSON, 'utf-8'));
}

// Save apps to JSON
function saveApps() {
  fs.writeFileSync(APPS_JSON, JSON.stringify(apps, null, 2));
}

// Endpoint ký IPA + tự động lấy Bundle ID & Title từ IPA
app.post('/sign', upload.fields([
  { name: 'ipa', maxCount: 1 },
  { name: 'p12', maxCount: 1 },
  { name: 'mobileprovision', maxCount: 1 }
]), async (req, res) => {
  try {
    let { p12Password, bundleId, title } = req.body;
    const ipaFile = req.files.ipa[0];
    const p12File = req.files.p12[0];
    const provFile = req.files.mobileprovision[0];

    // === TỰ ĐỘNG LẤY BUNDLE ID VÀ TÊN APP TỪ IPA ===
    let extractedBundleId = bundleId;
    let extractedTitle = title || 'My App';

    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(ipaFile.path);
      const zipEntries = zip.getEntries();

      // Tìm Info.plist trong Payload/*.app/Info.plist
      const plistEntry = zipEntries.find(entry => 
        entry.entryName.includes('Payload/') && 
        entry.entryName.endsWith('Info.plist')
      );

      if (plistEntry) {
        const plistContent = plistEntry.getData().toString('utf8');
        
        // Parse đơn giản CFBundleIdentifier
        const bundleMatch = plistContent.match(/<key>CFBundleIdentifier<\/key>[\s\S]*?<string>(.*?)<\/string>/);
        if (bundleMatch && bundleMatch[1]) {
          extractedBundleId = bundleMatch[1].trim();
        }

        // Parse CFBundleDisplayName hoặc CFBundleName
        const nameMatch = plistContent.match(/<key>CFBundleDisplayName<\/key>[\s\S]*?<string>(.*?)<\/string>/) ||
                         plistContent.match(/<key>CFBundleName<\/key>[\s\S]*?<string>(.*?)<\/string>/);
        if (nameMatch && nameMatch[1]) {
          extractedTitle = nameMatch[1].trim();
        }
      }
    } catch (parseErr) {
      console.log('Không tự động lấy được thông tin từ IPA, dùng giá trị người dùng nhập:', parseErr.message);
    }

    // Sử dụng giá trị tự động nếu người dùng chưa nhập
    bundleId = extractedBundleId || bundleId || 'com.example.app';
    title = extractedTitle;

    // Tiếp tục ký như cũ...
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const appDir = path.join(APPS_DIR, id);
    fs.mkdirSync(appDir, { recursive: true });

    const originalIpa = path.join(appDir, 'original.ipa');
    fs.copyFileSync(ipaFile.path, originalIpa);
    fs.copyFileSync(p12File.path, path.join(appDir, 'cert.p12'));
    fs.copyFileSync(provFile.path, path.join(appDir, 'profile.mobileprovision'));

    const signedIpaPath = path.join(appDir, 'signed.ipa');
    const zsignPath = path.join(__dirname, 'zsign');

    const signCmd = `"${zsignPath}" -i "${originalIpa}" -c "${path.join(appDir, 'cert.p12')}" -p "${p12Password}" -m "${path.join(appDir, 'profile.mobileprovision')}" -o "${signedIpaPath}" -b "${bundleId}"`;

    exec(signCmd, async (error) => {
      if (error) {
        return res.status(500).json({ success: false, error: 'Ký IPA thất bại. Kiểm tra password hoặc file.' });
      }

      const domain = process.env.RENDER_EXTERNAL_HOSTNAME 
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` 
        : `http://localhost:${PORT}`;

      const manifestContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${domain}/apps/${id}/signed.ipa</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${bundleId}</string>
        <key>bundle-version</key><string>1.0</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${title}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

      fs.writeFileSync(path.join(appDir, 'manifest.plist'), manifestContent);

      const installLink = `itms-services://?action=download-manifest&url=${domain}/apps/${id}/manifest.plist`;

      const appData = {
        id,
        title,
        installLink,
        downloads: 0,
        qr: await QRCode.toDataURL(installLink, { width: 280 }),
        createdAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
      };

      apps.push(appData);
      saveApps();

      res.json({ 
        success: true, 
        installLink, 
        qr: appData.qr, 
        id, 
        title,
        bundleId 
      });
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tăng download count
app.get('/track/:id', (req, res) => {
  const app = apps.find(a => a.id === req.params.id);
  if (app) {
    app.downloads++;
    saveApps();
  }
  res.sendStatus(200);
});

// API lấy danh sách app + thống kê
app.get('/api/apps', (req, res) => {
  res.json(apps);
});

app.get('/api/stats', (req, res) => {
  const totalDownloads = apps.reduce((sum, a) => sum + a.downloads, 0);
  res.json({ totalApps: apps.length, totalDownloads });
});

// Auto resign mỗi 7 ngày (chạy lúc 00:00)
cron.schedule('0 0 */7 * *', () => {
  console.log('🔄 Bắt đầu Auto Resign...');
  apps.forEach(appItem => {
    const appDir = path.join(APPS_DIR, appItem.id);
    const originalIpa = path.join(appDir, 'original.ipa');
    const signedIpa = path.join(appDir, 'signed.ipa');
    const p12 = path.join(appDir, 'cert.p12');
    const prov = path.join(appDir, 'profile.mobileprovision');

    if (fs.existsSync(originalIpa) && fs.existsSync(p12) && fs.existsSync(prov)) {
      const zsignPath = path.join(__dirname, 'zsign');
      const cmd = `"${zsignPath}" -i "${originalIpa}" -c "${p12}" -p "YOUR_P12_PASSWORD_HERE" -m "${prov}" -o "${signedIpa}"`;
      // Lưu ý: Thay "YOUR_P12_PASSWORD_HERE" bằng cách lưu password an toàn (environment variable) trong production
      exec(cmd, (err) => {
        if (err) console.error(`Resign lỗi app ${appItem.id}`);
        else console.log(`✅ Resign thành công app ${appItem.id}`);
      });
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 IPA Signer chạy tại port ${PORT}`);
  console.log(`📁 Apps lưu tại: ${APPS_DIR}`);
});
