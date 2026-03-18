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

// ===== STORAGE =====
const DATA_DIR = process.env.RENDER_DISK_PATH || '/tmp';
const APPS_DIR = path.join(DATA_DIR, 'apps');

console.log(`📁 Storage: ${APPS_DIR}`);

if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

app.use(express.static('public'));
app.use('/apps', express.static(APPS_DIR));

const upload = multer({ dest: '/tmp' });

// ===== DATABASE =====
let apps = [];
const APPS_JSON = path.join(DATA_DIR, 'apps.json');

if (fs.existsSync(APPS_JSON)) {
  apps = JSON.parse(fs.readFileSync(APPS_JSON, 'utf-8'));
}

function saveApps() {
  fs.writeFileSync(APPS_JSON, JSON.stringify(apps, null, 2));
}

// ===== FIX ZSIGN PERMISSION =====
const zsignPath = path.join(__dirname, 'zsign');

try {
  execSync(`chmod +x "${zsignPath}"`);
  console.log("✅ zsign ready");
} catch (e) {
  console.log("❌ chmod zsign lỗi:", e.message);
}

// ===== SIGN API =====
app.post('/sign', upload.fields([
  { name: 'ipa', maxCount: 1 },
  { name: 'p12', maxCount: 1 },
  { name: 'mobileprovision', maxCount: 1 }
]), async (req, res) => {
  try {
    let { p12Password, bundleId, title } = req.body;

    if (!req.files?.ipa || !req.files?.p12 || !req.files?.mobileprovision) {
      return res.json({ success: false, error: "Thiếu file upload" });
    }

    const ipaFile = req.files.ipa[0];
    const p12File = req.files.p12[0];
    const provFile = req.files.mobileprovision[0];

    // ===== AUTO PARSE IPA =====
    let extractedBundleId = bundleId;
    let extractedTitle = title || 'My App';

    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(ipaFile.path);
      const plist = zip.getEntries().find(e =>
        e.entryName.includes('Payload/') && e.entryName.endsWith('Info.plist')
      );

      if (plist) {
        const content = plist.getData().toString('utf8');

        const bundleMatch = content.match(/CFBundleIdentifier<\/key>[\s\S]*?<string>(.*?)<\/string>/);
        if (bundleMatch) extractedBundleId = bundleMatch[1];

        const nameMatch =
          content.match(/CFBundleDisplayName<\/key>[\s\S]*?<string>(.*?)<\/string>/) ||
          content.match(/CFBundleName<\/key>[\s\S]*?<string>(.*?)<\/string>/);

        if (nameMatch) extractedTitle = nameMatch[1];
      }
    } catch (e) {
      console.log("⚠ Không parse IPA:", e.message);
    }

    bundleId = extractedBundleId || bundleId || 'com.example.app';
    title = extractedTitle;

    // ===== CREATE APP DIR =====
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

    // ===== SIGN COMMAND =====
    const cmd = `"${zsignPath}" -v -i "${originalIpa}" -c "${cert}" -p "${p12Password}" -m "${prov}" -o "${signedIpa}" -b "${bundleId}"`;

    exec(cmd, async (error, stdout, stderr) => {
      console.log("CMD:", cmd);
      console.log("STDOUT:", stdout);
      console.log("STDERR:", stderr);

      if (error) {
        return res.json({ success: false, error: stderr || error.message });
      }

      // ===== CREATE MANIFEST =====
      const domain = process.env.RENDER_EXTERNAL_HOSTNAME
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
        : `http://localhost:${PORT}`;

      const manifest = `${appDir}/manifest.plist`;

      fs.writeFileSync(manifest, `<?xml version="1.0"?>
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
</plist>`);

      const installLink = `itms-services://?action=download-manifest&url=${domain}/apps/${id}/manifest.plist`;

      const appData = {
        id,
        title,
        bundleId,
        installLink,
        downloads: 0,
        password: p12Password, // 🔥 fix auto resign
        createdAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        qr: await QRCode.toDataURL(installLink)
      };

      apps.push(appData);
      saveApps();

      res.json({
        success: true,
        installLink,
        qr: appData.qr,
        id,
        title
      });
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===== DOWNLOAD TRACK =====
app.get('/track/:id', (req, res) => {
  const a = apps.find(x => x.id === req.params.id);
  if (a) {
    a.downloads++;
    saveApps();
  }
  res.sendStatus(200);
});

// ===== STATS =====
app.get('/api/apps', (req, res) => res.json(apps));

// ===== AUTO RESIGN =====
cron.schedule('0 0 */7 * *', () => {
  console.log("🔄 Auto resign...");

  apps.forEach(appItem => {
    const dir = path.join(APPS_DIR, appItem.id);

    const cmd = `"${zsignPath}" -i "${dir}/original.ipa" -c "${dir}/cert.p12" -p "${appItem.password}" -m "${dir}/profile.mobileprovision" -o "${dir}/signed.ipa"`;

    exec(cmd, (err) => {
      if (err) console.log("❌ resign lỗi:", appItem.id);
      else console.log("✅ resign:", appItem.id);
    });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server chạy port ${PORT}`);
});
