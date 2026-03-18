import express from 'express';
import multer from 'multer';
import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ===== FIX STORAGE RENDER =====
const DATA_DIR = process.env.RENDER_DISK_PATH || '/tmp';
const APPS_DIR = path.join(DATA_DIR, 'apps');

if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

app.use(express.static('public'));
app.use('/apps', express.static(APPS_DIR));

const upload = multer({ dest: '/tmp' });

// ===== FIX ZSIGN PERMISSION =====
const zsignPath = path.join(__dirname, 'zsign');

try {
  execSync(`chmod +x "${zsignPath}"`);
  console.log("✅ zsign permission OK");
} catch (e) {
  console.log("❌ chmod zsign lỗi:", e.message);
}

// ===== DATABASE =====
let apps = [];
const APPS_JSON = path.join(DATA_DIR, 'apps.json');

if (fs.existsSync(APPS_JSON)) {
  apps = JSON.parse(fs.readFileSync(APPS_JSON, 'utf-8'));
}

function saveApps() {
  fs.writeFileSync(APPS_JSON, JSON.stringify(apps, null, 2));
}

// ===== SIGN IPA =====
app.post('/sign', upload.fields([
  { name: 'ipa', maxCount: 1 },
  { name: 'p12', maxCount: 1 },
  { name: 'mobileprovision', maxCount: 1 }
]), async (req, res) => {
  try {
    let { p12Password, bundleId, title } = req.body;

    const ipaFile = req.files.ipa?.[0];
    const p12File = req.files.p12?.[0];
    const provFile = req.files.mobileprovision?.[0];

    if (!ipaFile || !p12File || !provFile) {
      return res.json({ success: false, error: "Thiếu file upload" });
    }

    // ===== AUTO GET INFO FROM IPA =====
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(ipaFile.path);

      const entry = zip.getEntries().find(e =>
        e.entryName.includes('Payload/') && e.entryName.endsWith('Info.plist')
      );

      if (entry) {
        const content = entry.getData().toString('utf8');

        const bundleMatch = content.match(/CFBundleIdentifier<\/key>[\s\S]*?<string>(.*?)<\/string>/);
        const nameMatch = content.match(/CFBundleDisplayName<\/key>[\s\S]*?<string>(.*?)<\/string>/);

        if (bundleMatch) bundleId = bundleMatch[1];
        if (nameMatch) title = nameMatch[1];
      }
    } catch (e) {
      console.log("Parse IPA lỗi:", e.message);
    }

    bundleId = bundleId || 'com.example.app';
    title = title || 'My App';

    const id = Date.now().toString(36);
    const appDir = path.join(APPS_DIR, id);
    fs.mkdirSync(appDir, { recursive: true });

    const originalIpa = path.join(appDir, 'original.ipa');
    const signedIpa = path.join(appDir, 'signed.ipa');
    const cert = path.join(appDir, 'cert.p12');
    const prov = path.join(appDir, 'profile.mobileprovision');

    fs.copyFileSync(ipaFile.path, originalIpa);
    fs.copyFileSync(p12File.path, cert);
    fs.copyFileSync(provFile.path, prov);

    const cmd = `"${zsignPath}" -v -i "${originalIpa}" -c "${cert}" -p "${p12Password}" -m "${prov}" -o "${signedIpa}" -b "${bundleId}"`;

    exec(cmd, async (error, stdout, stderr) => {
      console.log("CMD:", cmd);
      console.log("STDOUT:", stdout);
      console.log("STDERR:", stderr);

      if (error) {
        return res.json({
          success: false,
          error: stderr || error.message
        });
      }

      const domain = process.env.RENDER_EXTERNAL_HOSTNAME
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
        : `http://localhost:${PORT}`;

      // ===== MANIFEST =====
      const manifest = `<?xml version="1.0" encoding="UTF-8"?>
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

      fs.writeFileSync(path.join(appDir, 'manifest.plist'), manifest);

      const installLink = `itms-services://?action=download-manifest&url=${domain}/apps/${id}/manifest.plist`;

      const qr = await QRCode.toDataURL(installLink);

      apps.push({
        id,
        title,
        bundleId,
        password: p12Password, // 🔥 FIX AUTO RESIGN
        downloads: 0,
        installLink,
        qr,
        createdAt: Date.now()
      });

      saveApps();

      res.json({
        success: true,
        installLink,
        qr,
        title
      });
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===== DOWNLOAD TRACK =====
app.get('/track/:id', (req, res) => {
  const appItem = apps.find(a => a.id === req.params.id);
  if (appItem) {
    appItem.downloads++;
    saveApps();
  }
  res.sendStatus(200);
});

// ===== STATS =====
app.get('/api/apps', (req, res) => res.json(apps));

app.get('/api/stats', (req, res) => {
  res.json({
    totalApps: apps.length,
    totalDownloads: apps.reduce((s, a) => s + a.downloads, 0)
  });
});

// ===== AUTO RESIGN (FIXED) =====
cron.schedule('0 0 */7 * *', () => {
  console.log("🔄 Auto resign chạy...");

  apps.forEach(appItem => {
    const appDir = path.join(APPS_DIR, appItem.id);

    const cmd = `"${zsignPath}" -i "${appDir}/original.ipa" -c "${appDir}/cert.p12" -p "${appItem.password}" -m "${appDir}/profile.mobileprovision" -o "${appDir}/signed.ipa"`;

    exec(cmd, (err) => {
      if (err) console.log("❌ Resign lỗi:", appItem.id);
      else console.log("✅ Resign OK:", appItem.id);
    });
  });
});

app.listen(PORT, () => {
  console.log("🚀 Server running:", PORT);
});
