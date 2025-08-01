const { MessageMedia } = require('whatsapp-web.js');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

module.exports = {
    name: 'yt',
    description: 'Download YouTube video or audio by URL or query',
    adminOnly: false,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        if (args.length === 0) {
            await message.reply(
                '◉ Usage: .yt <url/query> [quality]\n' +
                '◉ Quality:\n' +
                '  • 144p, 240p, 360p, 480p, 720p, 1080p\n' +
                '  • low, medium, high\n' +
                '  • audio or mp3 for music only\n' +
                '◉ Example:\n' +
                '  • .yt https://youtu.be/dQw4w9WgXcQ\n' +
                '  • .yt rick astley never gonna give you up audio\n' +
                '  • .yt despacito 360p'
            );
            return;
        }

        const input = args[0];
        const quality = args[1]?.toLowerCase() || 'high';
        const isAudio = quality === 'audio' || quality === 'mp3';
        const tempDir = path.join(__dirname, '../tmp');
        const timestamp = Date.now();

        let statusMessage = await message.reply('◉ Processing...');

        try {
            await ensureDir(tempDir);
            const isUrl = input.includes('youtube.com') || input.includes('youtu.be');
            let videoInfo, videoUrl = input;

            if (!isUrl) {
                await editMessage(statusMessage, '◉ Searching...');
                const searchQuery = args.join(' ').replace(quality, '').trim();
                const results = await searchYoutube(searchQuery);
                if (!results.length) {
                    await editMessage(statusMessage, '✕ No results found.');
                    return;
                }
                videoInfo = results[0];
                videoUrl = videoInfo.url;
            }

            if (!videoInfo) {
                await editMessage(statusMessage, '◉ Getting video info...');
                videoInfo = await getVideoInfo(videoUrl);
            }

            const shortTitle = videoInfo.title.length > 50 ? videoInfo.title.slice(0, 47) + '...' : videoInfo.title;
            await editMessage(statusMessage, `◉ Title: ${shortTitle}\n◉ Quality: ${quality}\n◉ Downloading...`);

            const basePath = path.join(tempDir, `${timestamp}_yt`);
            if (isAudio) {
                await downloadAudio(videoUrl, basePath);
            } else {
                await downloadVideo(videoUrl, basePath, quality);
            }

            const files = await fs.readdir(tempDir);
            const file = files.find(f => f.startsWith(`${timestamp}_yt`) && (
                f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv') ||
                f.endsWith('.mp3') || f.endsWith('.m4a')
            ));

            if (!file) {
                await editMessage(statusMessage, '✕ Download failed.');
                return;
            }

            const filePath = path.join(tempDir, file);
            let finalPath = filePath;

            if (isAudio && !file.endsWith('.mp3')) {
                finalPath = path.join(tempDir, `${timestamp}_final.mp3`);
                await convertToMp3(filePath, finalPath);
            } else if (!isAudio && !file.endsWith('.mp4')) {
                finalPath = path.join(tempDir, `${timestamp}_final.mp4`);
                await convertToMp4(filePath, finalPath);
            }

            const stats = await fs.stat(finalPath);
            const sizeMB = stats.size / (1024 * 1024);

            if (sizeMB > 100) {
                await editMessage(statusMessage, `✕ File too large (${sizeMB.toFixed(1)}MB). Try lower quality.`);
                await cleanup([filePath, finalPath]);
                return;
            }

            await editMessage(statusMessage, `◉ Title: ${shortTitle}\n◉ Size: ${sizeMB.toFixed(1)}MB\n◉ Uploading...`);
            const buffer = await fs.readFile(finalPath);
            const media = new MessageMedia(
                isAudio ? 'audio/mpeg' : 'video/mp4',
                buffer.toString('base64'),
                `${shortTitle}.${isAudio ? 'mp3' : 'mp4'}`
            );

            await message.reply(media);
            await editMessage(statusMessage, `◉ Sent: ${shortTitle}`);

            await cleanup([filePath, finalPath]);
        } catch (e) {
            console.error('[yt error]', e);
            await editMessage(statusMessage, '✕ Error: ' + (e.message || 'Unknown'));
        }
    }
};

async function searchYoutube(query) {
    const cmd = `yt-dlp --dump-json --flat-playlist --playlist-end 3 "ytsearch3:${query}"`;
    const { stdout } = await execAsync(cmd, { timeout: 30000 });
    const results = stdout.trim().split('\n').map(line => {
        const data = JSON.parse(line);
        return {
            title: data.title || 'Unknown',
            url: `https://www.youtube.com/watch?v=${data.id}`,
            duration: formatDuration(data.duration),
            uploader: data.uploader || data.channel || 'Unknown',
            view_count: data.view_count || 0,
            id: data.id
        };
    });
    return results;
}

async function getVideoInfo(url) {
    const cmd = `yt-dlp --print "%(title)s||%(duration)s||%(uploader)s||%(id)s" "${url}"`;
    const { stdout } = await execAsync(cmd, { timeout: 20000 });
    const [title, duration, uploader, id] = stdout.trim().split('||');
    return {
        title: title || 'Unknown',
        url,
        duration: formatDuration(parseInt(duration)),
        uploader: uploader || 'Unknown',
        id: id || ''
    };
}

async function downloadVideo(url, outputPath, quality) {
    const format = getFormatSelector(quality);
    const cmd = `yt-dlp -f "${format}" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    await execAsync(cmd, { timeout: 600000 });
}

async function downloadAudio(url, outputPath) {
    const cmd = `yt-dlp --extract-audio --audio-format mp3 --audio-quality 0 -o "${outputPath}.%(ext)s" "${url}"`;
    await execAsync(cmd, { timeout: 600000 });
}

function getFormatSelector(q) {
    const map = {
        '144p': 'best[height<=144]/worst',
        '240p': 'best[height<=240]/best[height<=360]/worst',
        '360p': 'best[height<=360]/best[height<=480]/worst',
        '480p': 'best[height<=480]/best[height<=720]/best',
        '720p': 'best[height<=720]/best[height<=1080]/best',
        '1080p': 'best[height<=1080]/best',
        'low': 'worst[height>=144]/worst',
        'medium': 'best[height<=480]/best[height<=720]/best',
        'high': 'best[height<=720]/best[height<=1080]/best'
    };
    return map[q.toLowerCase()] || map['high'];
}

async function convertToMp3(input, output) {
    const cmd = `ffmpeg -i "${input}" -vn -acodec libmp3lame -ab 192k -ar 44100 -y "${output}"`;
    await execAsync(cmd, { timeout: 300000 });
}

async function convertToMp4(input, output) {
    const cmd = `ffmpeg -i "${input}" -c:v libx264 -c:a aac -movflags +faststart -y "${output}"`;
    await execAsync(cmd, { timeout: 300000 });
}

async function editMessage(message, text) {
    try {
        await message.edit(text);
    } catch (_) {}
}

function formatDuration(s) {
    if (!s || isNaN(s)) return 'Unknown';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

async function ensureDir(dir) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (_) {}
}

async function cleanup(paths) {
    for (const file of paths) {
        try {
            await fs.unlink(file);
        } catch (_) {}
    }
}
