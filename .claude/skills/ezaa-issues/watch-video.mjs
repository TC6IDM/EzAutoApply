// Turn a TikTok / Instagram reel / YouTube Short link into things Claude can read: the caption,
// a contact sheet of frames, sharper single frames, the last frame (lists usually end complete),
// the platform's captions as text, and (if a speech-to-text tool is installed) a transcript.
//
//   node .claude/skills/<prefix>-issues/watch-video.mjs <url> [--frames 12] [--cookies-from-browser firefox]
//                                                       [--out <dir>] [--fresh-tools]
//   node .claude/skills/<prefix>-issues/watch-video.mjs --file <saved-video.mp4>   (no download)
//
// Needs only Node. yt-dlp is the official build, downloaded into a per-user tools folder and
// refreshed weekly (PATH's copy only if that fails); ffmpeg is used from PATH when present,
// otherwise downloaded once into the same folder. Downloads are checked against their published
// SHA-256 sums (yt-dlp: github.com/yt-dlp/yt-dlp releases; ffmpeg: github.com/BtbN/FFmpeg-Builds,
// Windows and Linux). macOS without ffmpeg: the frames come from AVFoundation instead, through a
// small Swift program compiled once into the tools folder (#541; Xcode's command-line tools).
// --fresh-tools ignores PATH and uses the downloaded copies (to test what a new machine sees).
//
// Everything downloaded is untrusted: it lands in a new, empty folder under the system temp
// folder, outside the repo, and nothing in it is run.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync, statSync, cpSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const url = args.find(a => /^https?:\/\//.test(a));
const local = opt('file');
if (!url && !local) { console.error('usage: watch-video.mjs <url> | --file <video> [--frames 12] [--cookies-from-browser firefox] [--out dir] [--fresh-tools]'); process.exit(1); }
if (local && !existsSync(local)) { console.error(`no such file: ${local}`); process.exit(1); }
const FRAMES = Math.min(30, Math.max(4, Number(opt('frames')) || 12));
const fresh = args.includes('--fresh-tools');
const win = process.platform === 'win32', mac = process.platform === 'darwin', arm = process.arch === 'arm64';
const exe = name => win ? `${name}.exe` : name;
const TOOLS = join(win ? (process.env.LOCALAPPDATA || homedir()) : join(homedir(), '.cache'), 'claude-workflow-tools');
mkdirSync(TOOLS, { recursive: true });

function onPath(name) {
  if (fresh) return null;
  const r = spawnSync(win ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}
async function download(from, to) {
  const res = await fetch(from, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${from}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(to, bytes);
  return bytes;
}
async function verified(sumsUrl, assetName, bytes) {
  const sums = await (await fetch(sumsUrl, { redirect: 'follow' })).text();
  const line = sums.split('\n').find(l => l.trim().endsWith(assetName));
  if (!line) throw new Error(`no checksum for ${assetName}`);
  const want = line.trim().split(/\s+/)[0].toLowerCase();
  const got = createHash('sha256').update(bytes).digest('hex');
  if (want !== got) throw new Error(`checksum mismatch for ${assetName}; refusing to use it`);
}

// yt-dlp: our own copy of the official build first. It bundles browser impersonation, which
// TikTok now demands; a copy installed with pip usually lacks it and is often months old.
async function ytDlp() {
  try { return await officialYtDlp(); }
  catch (error) {
    const found = onPath('yt-dlp');
    if (found) { console.log(`could not get yt-dlp (${error.message}); using ${found}`); return found; }
    throw error;
  }
}
async function officialYtDlp() {
  const asset = win ? (arm ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe') : mac ? 'yt-dlp_macos' : (arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux');
  const target = join(TOOLS, exe('yt-dlp'));
  // Re-download when older than a week: TikTok and Instagram break old versions often.
  if (existsSync(target) && Date.now() - statSync(target).mtimeMs < 7 * 864e5) return target;
  console.log(`getting yt-dlp (${asset})…`);
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  const bytes = await download(`${base}/${asset}`, target);
  await verified(`${base}/SHA2-256SUMS`, asset, bytes);
  if (!win) chmodSync(target, 0o755);
  return target;
}
async function ffmpeg() {
  const found = onPath('ffmpeg');
  if (found) return found;
  const target = join(TOOLS, 'ffmpeg', 'bin', exe('ffmpeg'));
  if (existsSync(target)) return target;
  if (mac) return null; // AVFoundation draws the frames instead (avFrames() below)
  const asset = win ? `ffmpeg-master-latest-${arm ? 'winarm64' : 'win64'}-gpl.zip` : `ffmpeg-master-latest-${arm ? 'linuxarm64' : 'linux64'}-gpl.tar.xz`;
  console.log(`getting ffmpeg (${asset}, ~100 MB, once)…`);
  const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
  const archive = join(TOOLS, asset);
  const bytes = await download(`${base}/${asset}`, archive);
  await verified(`${base}/checksums.sha256`, asset, bytes);
  const unpack = join(TOOLS, 'ffmpeg-unpack');
  mkdirSync(unpack, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', unpack]); // Windows 10+ ships bsdtar, which reads zip
  const top = readdirSync(unpack).find(d => d.startsWith('ffmpeg-'));
  cpSync(join(unpack, top, 'bin'), join(TOOLS, 'ffmpeg', 'bin'), { recursive: true });
  rmSync(unpack, { recursive: true, force: true }); rmSync(archive, { force: true });
  if (!existsSync(target)) throw new Error('ffmpeg unpack failed');
  return target;
}

const out = opt('out') || mkdtempSync(join(tmpdir(), 'claude-workflow-video-'));
mkdirSync(out, { recursive: true });
const ff = await ffmpeg().catch(error => { console.log(`ffmpeg unavailable (${error.message}); continuing without frames.`); return null; });

if (local) {
  // A video saved by hand (e.g. a reel downloaded on the phone): no yt-dlp, no network.
  cpSync(local, join(out, `video.${local.split('.').pop().toLowerCase()}`));
  const probe = ff ? spawnSync(ff, ['-i', local], { encoding: 'utf8' }).stderr.match(/Duration: (\d+):(\d+):([\d.]+)/) : null;
  const seconds = probe ? Number(probe[1]) * 3600 + Number(probe[2]) * 60 + Number(probe[3]) : 30;
  writeFileSync(join(out, 'video.info.json'), JSON.stringify({ title: local.split(/[\\/]/).pop(), duration: Math.round(seconds), webpage_url: local }));
} else {
const yt = await ytDlp();
const ytArgs = ['--no-playlist', '--no-update', '--write-info-json', '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--sub-format', 'vtt/best',
  '-f', 'mp4/best', '-o', join(out, 'video.%(ext)s')];
if (ff) ytArgs.push('--ffmpeg-location', ff);
if (opt('cookies-from-browser')) ytArgs.push('--cookies-from-browser', opt('cookies-from-browser'));
const got = spawnSync(yt, [...ytArgs, url], { encoding: 'utf8' });
if (got.status !== 0) {
  console.error(got.stderr.split('\n').filter(l => /ERROR/.test(l)).join('\n') || got.stderr.slice(-800));
  console.error('\nInstagram usually needs a signed-in browser: add --cookies-from-browser firefox (Chrome\'s cookies are often unreadable on Windows).');
  console.error('Otherwise: save the video on the phone or computer and run with --file <path>, or open the link with Claude in Chrome and read the page and screenshots.');
  process.exit(1);
}
}

const files = readdirSync(out);
const video = files.find(f => /^video\.(mp4|webm|mkv|mov)$/.test(f));
const info = JSON.parse(readFileSync(join(out, files.find(f => f.endsWith('.info.json'))), 'utf8'));
const duration = Number(info.duration) || 30;
const summary = [`Title: ${info.title || ''}`, `By: ${info.uploader || info.channel || ''}`, `Length: ${duration}s`, `Link: ${info.webpage_url || url}`, '', 'Caption:', info.description || '(none)'].join('\n');
writeFileSync(join(out, 'summary.txt'), summary);

// Platform captions → plain text, one line per cue, repeats dropped.
const vtt = files.find(f => f.endsWith('.vtt'));
if (vtt) {
  const lines = readFileSync(join(out, vtt), 'utf8').split(/\r?\n/).filter(l => l && !/-->|^WEBVTT|^Kind:|^Language:|^\d+$/.test(l)).map(l => l.replace(/<[^>]+>/g, '').trim());
  writeFileSync(join(out, 'captions.txt'), lines.filter((l, i) => l && l !== lines[i - 1]).join('\n'));
}

// macOS without ffmpeg (#541): the same three images through AVFoundation. The
// program is this file's own text, compiled once into the tools folder (rebuilt
// when the text changes); nothing downloaded is ever run.
const AV_SOURCE = String.raw`import AVFoundation
import AppKit
let a = CommandLine.arguments
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1])), out = a[2], count = Int(a[3]) ?? 12
func jpeg(_ image: CGImage, width: Double, to path: String) {
  let height = width * Double(image.height) / Double(image.width)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width), pixelsHigh: Int(height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSImage(cgImage: image, size: .zero).draw(in: NSRect(x: 0, y: 0, width: width, height: height))
  NSGraphicsContext.restoreGraphicsState()
  try? rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])!.write(to: URL(fileURLWithPath: path))
}
let done = DispatchSemaphore(value: 0)
Task {
  defer { done.signal() }
  let generator = AVAssetImageGenerator(asset: asset)
  generator.appliesPreferredTrackTransform = true
  generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
  guard let duration = try? await asset.load(.duration).seconds, duration > 0 else { return }
  print(String(format: "duration %.2f", duration))
  var frames: [CGImage] = []
  for i in 0..<count {
    let at = CMTime(seconds: duration * (Double(i) + 0.5) / Double(count), preferredTimescale: 600)
    if let (image, _) = try? await generator.image(at: at) { frames.append(image); jpeg(image, width: 720, to: String(format: "%@/frames/f%02d.jpg", out, i + 1)) }
  }
  if let (image, _) = try? await generator.image(at: CMTime(seconds: max(0, duration - 0.3), preferredTimescale: 600)) { jpeg(image, width: 1080, to: out + "/last.jpg") }
  guard let first = frames.first else { return }
  let cols = min(6, frames.count), rows = (frames.count + cols - 1) / cols, w = 360.0, h = w * Double(first.height) / Double(first.width)
  let sheet = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(w) * cols, pixelsHigh: Int(h) * rows, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: sheet)
  for (i, image) in frames.enumerated() { NSImage(cgImage: image, size: .zero).draw(in: NSRect(x: Double(i % cols) * w, y: Double(rows - 1 - i / cols) * h, width: w, height: h)) }
  NSGraphicsContext.restoreGraphicsState()
  try? sheet.representation(using: .jpeg, properties: [.compressionFactor: 0.75])!.write(to: URL(fileURLWithPath: out + "/contact.jpg"))
}
done.wait()
`;
function avFrames(src) {
  if (!mac || !onPath('swiftc') && !existsSync('/usr/bin/swiftc')) return false;
  const hash = createHash('sha256').update(AV_SOURCE).digest('hex').slice(0, 12);
  const dir = join(TOOLS, 'avframes'), bin = join(dir, `avframes-${hash}`);
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'avframes.swift'), AV_SOURCE);
    console.log('building the AVFoundation frame reader (once)…');
    const built = spawnSync('swiftc', ['-O', join(dir, 'avframes.swift'), '-o', bin], { encoding: 'utf8' });
    if (built.status !== 0) { console.log(`could not build it (${(built.stderr || '').split('\n').find(l => /error/.test(l)) || 'swiftc failed'}); continuing without frames.`); return false; }
  }
  mkdirSync(join(out, 'frames'), { recursive: true });
  const ran = spawnSync(bin, [src, out, String(FRAMES)], { encoding: 'utf8' });
  return ran.status === 0 && existsSync(join(out, 'contact.jpg'));
}

if (!ff && video && avFrames(join(out, video))) console.log('frames drawn with AVFoundation (no ffmpeg on this Mac)');
if (ff && video) {
  const src = join(out, video), every = (duration / FRAMES).toFixed(2), cols = Math.min(6, FRAMES), rows = Math.ceil(FRAMES / cols);
  const run = list => spawnSync(ff, ['-loglevel', 'error', '-y', ...list], { stdio: 'inherit' });
  run(['-i', src, '-vf', `fps=1/${every},scale=360:-1,tile=${cols}x${rows}`, '-frames:v', '1', join(out, 'contact.jpg')]);
  mkdirSync(join(out, 'frames'), { recursive: true });
  run(['-i', src, '-vf', `fps=1/${every},scale=720:-1`, join(out, 'frames', 'f%02d.jpg')]);
  run(['-sseof', '-0.3', '-i', src, '-vf', 'scale=1080:-1', '-frames:v', '1', join(out, 'last.jpg')]);
  // Speech: only if a speech-to-text tool is already installed (it is large; never installed here).
  const whisper = onPath('whisper');
  if (whisper) {
    console.log('transcribing speech with whisper…');
    spawnSync(whisper, [src, '--model', 'base', '--output_format', 'txt', '--output_dir', out], { stdio: 'ignore', env: { ...process.env, PATH: `${join(ff, '..')}${win ? ';' : ':'}${process.env.PATH}` } });
  }
}

console.log(`\n${summary}\n\nRead these (in ${out}):`);
for (const f of ['contact.jpg', 'last.jpg', 'captions.txt', 'video.txt']) if (existsSync(join(out, f))) console.log(`  ${join(out, f)}`);
if (existsSync(join(out, 'frames'))) console.log(`  ${join(out, 'frames')}  (sharper single frames, for small text)`);
if (!existsSync(join(out, 'video.txt'))) console.log('No speech transcript (no whisper installed). On-screen text, the caption and platform captions usually carry it; say so if the audio matters.');
