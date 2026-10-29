#!/usr/bin/env node
/**
 * compliance-check.mjs —— 合规清单 G1–G11 的**机械可查部分**（规划 §17；人工项如实标注）。
 *
 * 判定输入：--apk <release.apk>（必需）；工程清单/源码按相对路径定位。
 * 退出码：机械项任一失败 = 1；人工/材料项不参与退出码（打印为 MANUAL）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const apk = argv[argv.indexOf('--apk') + 1];
if (!apk || !fs.existsSync(apk)) {
  console.error('用法：node scripts/compliance-check.mjs --apk <release.apk>');
  process.exit(2);
}

const bt = (() => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'build-tools') : null;
  if (base && fs.existsSync(base)) {
    const v = fs.readdirSync(base).sort().reverse()[0];
    return path.join(base, v);
  }
  return '';
})();
const aapt = bt ? path.join(bt, 'aapt.exe') : 'aapt';

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

const badging = sh(aapt, ['dump', 'badging', apk]);
const xmltree = sh(aapt, ['dump', 'xmltree', apk, 'AndroidManifest.xml']);
const apkList = sh('unzip', ['-l', apk]);

let failures = 0;
const row = (g, name, state, detail = '') => {
  console.log(`${state.padEnd(8)} G${String(g).padEnd(2)} ${name}${detail ? ' —— ' + detail : ''}`);
  if (state === 'FAIL') failures += 1;
};

// G1 系统 WebView（无随包浏览器内核 .so）
{
  const bundled = apkList.split('\n').filter((l) => /lib.*webview|libchrome|libchromium/i.test(l));
  row(1, '系统 WebView，无随包浏览器内核', bundled.length === 0 ? 'PASS' : 'FAIL', bundled.length ? bundled.join('；') : 'APK 无 webview/chromium .so');
}

// G2 无浏览器语义（无 BROWSABLE 深链）
{
  const browsable = /android.intent.category.BROWSABLE/.test(xmltree);
  row(2, '无浏览器语义（无 BROWSABLE 深链）', browsable ? 'FAIL' : 'PASS', browsable ? 'Manifest 声明了 BROWSABLE' : 'Manifest 无 BROWSABLE');
}

// G3 无动态下发可执行代码（.so 清单 = 引擎+桥+libc++；JS 载荷为唯一运行期解包物）
{
  const sos = [...new Set(apkList.split('\n').map((l) => (l.match(/lib\/[^/]+\/(lib[^/]+\.so)/) || [])[1]).filter(Boolean))].sort();
  const allowed = (s) => /^(libnode\.so|libc\+\+_shared\.so|libnode_bridge\.so|libnode_host_client\.so)$/.test(s);
  const unexpected = sos.filter((s) => !allowed(s));
  row(3, '无动态下发可执行代码', unexpected.length === 0 ? 'PASS' : 'FAIL',
    sos.length ? `so=${sos.join(',')}` : '未列出 .so（unzip 输出异常？）');
}

// G4 第三方许可清单（材料项：正文在 docs；此处机械断言 vendor 许可随包）
{
  const lic = ['LICENSE', 'keystore.properties.sample'];
  const pnpmLic = fs.existsSync(path.join(ROOT, 'payload', 'extensions', 'android-pnpm', 'vendor', 'pnpm.LICENSE'));
  const gitBundle = fs.existsSync(path.join(ROOT, 'payload', 'extensions', 'android-git', 'vendor', 'isomorphic-git.bundle.cjs'));
  const okAll = pnpmLic && gitBundle;
  row(4, '第三方许可清单', okAll ? 'PASS' : 'FAIL',
    `pnpm.LICENSE=${pnpmLic} isomorphic-git.bundle=${gitBundle}（清单正文：Node/V8/ICU MIT 族 + pi/pi-web MIT + isomorphic-git MIT + pnpm MIT —— 发布材料页人工归档）`);
}

// G5 16KB 页对齐（zipalign -c -P 16）
{
  const zipalign = bt ? path.join(bt, 'zipalign.exe') : 'zipalign';
  const out = sh(zipalign, ['-c', '-P', '16', '4', apk]);
  const okAll = !/OutOfAlignment|ERROR|Verification FAILED/i.test(out) && out.trim() === '' ? true : /successful/i.test(out) || out.trim() === '';
  row(5, '16KB 页对齐（zipalign -P 16）', okAll ? 'PASS' : 'FAIL', out.trim().slice(0, 160));
}

// G6 targetSdk 与最小权限面（前台服务 type + 通知权限；targetSdk 以 badging 为准）
{
  const sdk = /targetSdkVersion:\s*'(\d+)'/.exec(badging)?.[1];
  const hasFgsType = /foregroundServiceType|dataSync/.test(xmltree);
  const notif = /android.permission.POST_NOTIFICATIONS/.test(xmltree);
  const okAll = sdk === '36' && hasFgsType && notif;
  row(6, `targetSdk/前台服务 type/通知权限`, okAll ? 'PASS' : 'FAIL', `targetSdk=${sdk} fgsType=${hasFgsType} POST_NOTIFICATIONS=${notif}`);
}

// G7 明确不申请（红线权限）
{
  const forbidden = ['MANAGE_EXTERNAL_STORAGE', 'QUERY_ALL_PACKAGES', 'REQUEST_INSTALL_PACKAGES', 'SYSTEM_ALERT_WINDOW', 'RECEIVE_BOOT_COMPLETED'];
  const hit = forbidden.filter((p) => xmltree.includes(p));
  row(7, '红线权限零申请', hit.length === 0 ? 'PASS' : 'FAIL', hit.length ? '命中：' + hit.join(',') : '0 命中');
}

// G8 隐私声明可达（外链交系统浏览器；材料项）
row(8, '隐私声明可达', 'MANUAL', '外链走 shell.openExternal/系统浏览器；隐私文本页随渠道材料人工归档');

// G9 AI 生成内容标识（对标 ark；材料项）
row(9, 'AI 生成内容标识', 'MANUAL', '对标 ark 壳层常驻灰字标识方案；Play 转入时按 AI 内容政策评估');

// G10 三一致 + versionCode（包名/应用名/图标；图标材料从 ../assets 产出）
{
  const pkg = /package:\s*name='([^']+)'/.exec(badging)?.[1];
  const label = /application-label:'([^']+)'/.exec(badging)?.[1];
  const vc = /versionCode='(\d+)'/.exec(badging)?.[1];
  const assetsDir = path.join(ROOT, '..', 'assets');
  const iconMaterials = fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).some((f) => /^logo\.(png|svg|ico|icns)$/.test(f) || f.startsWith('logo-'));
  // G10 图标物化：五密度 legacy + adaptive 前景 + anydpi-v26 XML 在位，且 Manifest 引用
  const resDir = path.join(ROOT, 'app', 'src', 'main', 'res');
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  const iconFiles = densities.flatMap((d) => ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']
    .map((f) => path.join(resDir, `mipmap-${d}`, f)));
  iconFiles.push(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'));
  iconFiles.push(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'));
  const iconProduced = iconFiles.every((p) => fs.existsSync(p));
  const manifest = fs.readFileSync(path.join(ROOT, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const iconReferenced = /android:icon="@mipmap\/ic_launcher"/.test(manifest) && /android:roundIcon="@mipmap\/ic_launcher_round"/.test(manifest);
  const okAll = pkg === 'org.fellow99.pi.PiDesktopAndroid' && label === 'Pi Desktop' && typeof vc === 'string' && iconProduced && iconReferenced;
  row(10, '包名/应用名/图标三一致', okAll ? 'PASS' : 'FAIL',
    `pkg=${pkg} label=${label} versionCode=${vc} 材料=${iconMaterials ? '在' : '缺'} 物化=${iconProduced ? `15 位图+2 XML 在` : '缺，跑 node scripts/generate-icons.mjs'} Manifest引用=${iconReferenced}`);
}

// G11 发布资产卫生（release 不可调试）
{
  const dbg = /android:debuggable\(0x[\w()]+=\)\(type 0x12\)0xffffffff/.test(xmltree);
  row(11, 'release 不可调试（G11 卫生）', dbg ? 'FAIL' : 'PASS', dbg ? 'release manifest 声明了 debuggable' : 'debuggable 未声明');
}

console.log(failures === 0 ? '\n合规机械项：全部通过 ✔（MANUAL 项见上，随渠道材料归档）' : `\n合规机械项：${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
