const { MessageMedia } = require('whatsapp-web.js');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const TEMP_DIR = path.join(__dirname, '../tmp');

const API_ENDPOINTS = [
    {
        name: 'tikwm',
        url: 'https://www.tikwm.com/api/',
        params: (url) => ({ url: url, hd: 1 }),
        parseData: (data) => data?.data
    },
    {
        name: 'tiktokapi',
        url: 'https://tiktokapi.ga/api/download/v2',
        params: (url) => ({ url: url }),
        parseData: (data) => data?.result
    },
    {
        name: 'tikmate',
        url: 'https://tikmate.online/download',
        params: (url) => ({ url: url }),
        parseData: (data) => data?.data
    },
    {
        name: 'snaptik',
        url: 'https://snaptik.app/abc',
        params: (url) => ({ url: url, token: 'VIP' }),
        parseData: (data) => data?.data
    }
];

module.exports = {
    name: 'tt',
    description: 'Download TikTok video, audio or image set (VT)',
    adminOnly: false,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        if (!args.length) return message.reply('Usage: .tt <url> [--hd] [--audio] [--select <indices>]');

        const fullArgs = args.join(' ');
        const hdRequested = fullArgs.includes('--hd');
        const audioRequested = fullArgs.includes('--audio');
        
        let url = fullArgs.replace(/--hd/g, '').replace(/--audio/g, '').trim();
        let imageSelection = null;
        
        if (fullArgs.includes('--select')) {
            const selectMatch = fullArgs.match(/--select\s+([\d\s-]+)/);
            if (selectMatch) {
                imageSelection = selectMatch[1];
                url = url.replace(/--select\s+[\d\s-]+/g, '').trim();
            }
        }

        const cleanUrl = cleanTikTokUrl(url);
        if (!cleanUrl) return message.reply('Invalid TikTok URL. Please provide a valid TikTok link.');

        const timestamp = Date.now();
        const statusMessage = await message.reply('◐ Fetching TikTok metadata...');

        try {
            await ensureDir(TEMP_DIR);
            
            let data = null;
            let lastError = null;
            
            for (const api of API_ENDPOINTS) {
                try {
                    await editMessage(statusMessage, `◐ Trying ${api.name} API...`);
                    data = await fetchTikTokMetadata(cleanUrl, api);
                    if (data) break;
                } catch (error) {
                    lastError = error;
                    console.log(`${api.name} API failed:`, error.message);
                    continue;
                }
            }

            if (!data) {
                throw new Error(`All APIs failed. Last error: ${lastError?.message || 'Unknown error'}`);
            }

            const titleLine = `${data.title}${data.description ? ` | ${data.description}` : ''}`;
            const authorLine = `Author: @${data.author}`;

            if (data.type === 'Images') {
                await handleImageDownload(data, imageSelection, hdRequested, statusMessage, titleLine, authorLine, timestamp, message, client);
            } else if (data.type === 'Video') {
                await handleVideoDownload(data, audioRequested, hdRequested, statusMessage, titleLine, authorLine, timestamp, message, client);
            } else {
                throw new Error('Unsupported content type');
            }

        } catch (err) {
            console.error('TikTok download error:', err);
            let errorMessage = 'Download failed';
            
            if (err.message.includes('All APIs failed')) {
                errorMessage = 'All TikTok APIs are currently unavailable. Try again later.';
            } else if (err.message.includes('Invalid URL')) {
                errorMessage = 'Invalid or expired TikTok URL.';
            } else if (err.message.includes('timeout')) {
                errorMessage = 'Download timeout. Try with a shorter video.';
            } else if (err.message.includes('100MB')) {
                errorMessage = 'File too large (>100MB). Try a different format.';
            } else if (err.message.includes('Unsupported')) {
                errorMessage = 'Unsupported TikTok post type.';
            } else if (err.message.includes('rate limit') || err.message.includes('429')) {
                errorMessage = 'Rate limited. Please wait a moment and try again.';
            } else if (err.message.includes('403') || err.message.includes('Forbidden')) {
                errorMessage = 'Access denied. The video might be private or restricted.';
            } else if (err.message.includes('404') || err.message.includes('Not Found')) {
                errorMessage = 'Video not found. It might have been deleted.';
            } else if (err.message.includes('codec') || err.message.includes('conversion')) {
                errorMessage = 'Video format not supported. Conversion failed.';
            } else if (err.message.includes('Evaluation failed')) {
                errorMessage = 'WhatsApp upload failed. File might be corrupted.';
            }
            
            await editMessage(statusMessage, `✕ ${errorMessage}`);
        }
    }
};

function cleanTikTokUrl(url) {
    if (!url || typeof url !== 'string') return null;
    
    const tiktokPatterns = [
        /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/,
        /(?:https?:\/\/)?(?:vm\.|vt\.)?tiktok\.com\/(\w+)/,
        /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/t\/(\w+)/,
        /(?:https?:\/\/)?(?:m\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/
    ];
    
    for (const pattern of tiktokPatterns) {
        if (pattern.test(url)) {
            return url.split('?')[0].split('#')[0].trim();
        }
    }
    
    return null;
}

async function handleImageDownload(data, imageSelection, hdRequested, statusMessage, titleLine, authorLine, timestamp, message, client) {
    const selectionIndices = parseImageSelection(imageSelection, data.images.length);
    const selectedImages = selectionIndices.map(i => ({
        url: data.images[i],
        index: i
    }));

    await editMessage(statusMessage,
        `◉ ${titleLine}
◉ ${authorLine}
◉ Selected: ${selectionIndices.map(i => i + 1).join(', ')}
◉ Downloading... 0/${selectedImages.length}`
    );

    const downloadedFiles = [];
    for (let i = 0; i < selectedImages.length; i++) {
        const img = selectedImages[i];
        const localPath = path.join(TEMP_DIR, `${timestamp}_${i}.jpg`);
        
        try {
            await downloadFile(img.url, localPath);
            downloadedFiles.push({ path: localPath, label: img.index + 1 });
            
            await editMessage(statusMessage,
                `◉ ${titleLine}
◉ ${authorLine}
◉ Downloading... ${i + 1}/${selectedImages.length}`
            );
        } catch (error) {
            console.error(`Failed to download image ${i + 1}:`, error);
            continue;
        }
    }

    if (downloadedFiles.length === 0) {
        throw new Error('Failed to download any images');
    }

    await editMessage(statusMessage,
        `◉ ${titleLine}
◉ ${authorLine}
◉ Uploading ${downloadedFiles.length} images...`
    );

    let uploadedCount = 0;
    for (let i = 0; i < downloadedFiles.length; i++) {
        const file = downloadedFiles[i];
        try {
            const buf = await fs.readFile(file.path);
            
            if (hdRequested) {
                const stats = await fs.stat(file.path);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                const filename = `${sanitizeFilename(data.title)}_${file.label}.jpg`;
                const document = new MessageMedia('image/jpeg', buf.toString('base64'), filename);
                await message.reply(document, undefined, { 
                    sendMediaAsDocument: true,
                    caption: `HD Image ${file.label} (${sizeMB}MB)`
                });
            } else {
                const media = new MessageMedia('image/jpeg', buf.toString('base64'), `Image_${file.label}.jpg`);
                await message.reply(media, undefined, { caption: `Image ${file.label}` });
            }
            
            uploadedCount++;
            await sleep(2000);
        } catch (error) {
            console.error(`Failed to send image ${file.label}:`, error);
            await message.reply(`❌ Failed to send image ${file.label}`);
        }
    }

    await editMessage(statusMessage,
        `◉ ${titleLine}
◉ ${authorLine}
◉ ${uploadedCount}/${downloadedFiles.length} images sent successfully ✓`
    );

    await cleanup(downloadedFiles.map(f => f.path));
}

async function handleVideoDownload(data, audioRequested, hdRequested, statusMessage, titleLine, authorLine, timestamp, message, client) {
    if (audioRequested) {
        await editMessage(statusMessage,
            `◉ ${titleLine}
◉ ${authorLine}
◉ Extracting audio...`
        );

        const audioPath = path.join(TEMP_DIR, `${timestamp}.mp3`);
        await extractAudioFromVideo(data.videoUrl, audioPath, hdRequested);
        
        const audioStats = await fs.stat(audioPath);
        if (audioStats.size === 0) {
            await cleanup([audioPath]);
            throw new Error('Audio extraction produced empty file');
        }
        
        const audioSizeMB = (audioStats.size / (1024 * 1024)).toFixed(1);
        if (audioStats.size > 100 * 1024 * 1024) {
            await cleanup([audioPath]);
            throw new Error(`Audio too large (${audioSizeMB}MB). WhatsApp limit is 100MB.`);
        }

        try {
            const buf = await fs.readFile(audioPath);
            
            if (hdRequested) {
                const filename = `${sanitizeFilename(data.title)}.mp3`;
                const document = new MessageMedia('audio/mpeg', buf.toString('base64'), filename);
                await message.reply(document, undefined, { 
                    sendMediaAsDocument: true,
                    caption: `Original Quality Audio (${audioSizeMB}MB)`
                });
            } else {
                const media = new MessageMedia('audio/mpeg', buf.toString('base64'), `${sanitizeFilename(data.title)}.mp3`);
                await message.reply(media);
            }
            
            await editMessage(statusMessage,
                `◉ ${titleLine}
◉ ${authorLine}
◉ Audio extracted and sent (${audioSizeMB}MB) ✓`
            );
        } catch (error) {
            console.error('Audio send error:', error);
            throw new Error('Failed to send audio file to WhatsApp');
        } finally {
            await cleanup([audioPath]);
        }
    } else {
        const rawVideoPath = path.join(TEMP_DIR, `${timestamp}_raw.mp4`);
        const processedVideoPath = path.join(TEMP_DIR, `${timestamp}_processed.mp4`);
        
        try {
            await editMessage(statusMessage,
                `◉ ${titleLine}
◉ ${authorLine}
◉ Downloading video...`
            );

            await downloadFile(data.videoUrl, rawVideoPath);
            
            const rawStats = await fs.stat(rawVideoPath);
            const rawSizeMB = rawStats.size / (1024 * 1024);
            
            if (rawStats.size === 0) {
                await cleanup([rawVideoPath]);
                throw new Error('Downloaded video file is empty');
            }
            
            console.log(`Raw video downloaded: ${rawSizeMB.toFixed(1)}MB`);

            if (hdRequested) {
                await editMessage(statusMessage,
                    `◉ ${titleLine}
◉ ${authorLine}
◉ Sending HD file (${rawSizeMB.toFixed(1)}MB)...`
                );

                const buf = await fs.readFile(rawVideoPath);
                if (!buf || buf.length === 0) {
                    throw new Error('Video file buffer is empty');
                }
                
                const filename = `${sanitizeFilename(data.title)}.mp4`;
                const document = new MessageMedia('video/mp4', buf.toString('base64'), filename);
                await message.reply(document, undefined, { 
                    sendMediaAsDocument: true,
                    caption: `HD Video (${rawSizeMB.toFixed(1)}MB)`
                });

                await editMessage(statusMessage,
                    `◉ ${titleLine}
◉ ${authorLine}
◉ HD file sent successfully (${rawSizeMB.toFixed(1)}MB) ✓`
                );

            } else {
                await editMessage(statusMessage,
                    `◉ ${titleLine}
◉ ${authorLine}
◉ Processing video (${rawSizeMB.toFixed(1)}MB)...`
                );

                await convertVideoForWhatsApp(rawVideoPath, processedVideoPath);
                
                const processedStats = await fs.stat(processedVideoPath);
                const processedSizeMB = processedStats.size / (1024 * 1024);
                
                if (processedStats.size === 0) {
                    await cleanup([rawVideoPath, processedVideoPath]);
                    throw new Error('Video processing produced empty file');
                }
                
                if (processedStats.size > 100 * 1024 * 1024) {
                    await cleanup([rawVideoPath, processedVideoPath]);
                    throw new Error(`Video still too large (${processedSizeMB.toFixed(1)}MB). Try --audio or --hd`);
                }

                await editMessage(statusMessage,
                    `◉ ${titleLine}
◉ ${authorLine}
◉ Uploading video (${processedSizeMB.toFixed(1)}MB)...`
                );

                const buf = await fs.readFile(processedVideoPath);
                if (!buf || buf.length === 0) {
                    throw new Error('Video file buffer is empty');
                }
                
                const media = new MessageMedia('video/mp4', buf.toString('base64'), `${sanitizeFilename(data.title)}.mp4`);
                const caption = `${data.title}\n@${data.author}\nProcessed for WhatsApp ✓`;
                
                await message.reply(media, undefined, { caption: caption });

                await editMessage(statusMessage,
                    `◉ ${titleLine}
◉ ${authorLine}
◉ Video sent successfully (${processedSizeMB.toFixed(1)}MB) ✓`
                );
            }

        } catch (error) {
            console.error('Video processing error:', error);
            
            if (error.message.includes('Evaluation failed') || error.message.includes('puppeteer')) {
                throw new Error(`WhatsApp upload failed. Try --hd for file format or --audio`);
            } else if (error.message.includes('conversion') || error.message.includes('ffmpeg')) {
                throw new Error(`Video conversion failed: ${error.message}`);
            } else {
                throw new Error(`Video processing failed: ${error.message}`);
            }
        } finally {
            await cleanup([rawVideoPath, processedVideoPath].filter(Boolean));
        }
    }
}

async function convertVideoForWhatsApp(inputPath, outputPath) {
    try {
        try {
            await execAsync('ffmpeg -version', { timeout: 5000 });
        } catch (error) {
            throw new Error('ffmpeg not found. Please install ffmpeg for video processing.');
        }

        const probeCmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${inputPath}"`;
        const probeResult = await execAsync(probeCmd, { timeout: 15000 });
        const probeData = JSON.parse(probeResult.stdout);
        
        const videoStream = probeData.streams.find(s => s.codec_type === 'video');
        if (!videoStream) {
            throw new Error('No video stream found in file');
        }

        const width = parseInt(videoStream.width) || 720;
        const height = parseInt(videoStream.height) || 1280;
        const duration = parseFloat(probeData.format.duration) || 30;
        const originalBitrate = parseInt(probeData.format.bit_rate) || 1000000;

        console.log(`Video info: ${width}x${height}, ${duration.toFixed(1)}s, bitrate: ${originalBitrate}`);

        let targetWidth = width;
        let targetHeight = height;
        
        if (targetWidth % 2 !== 0) targetWidth -= 1;
        if (targetHeight % 2 !== 0) targetHeight -= 1;
        
        const maxDimension = 1280;
        if (Math.max(targetWidth, targetHeight) > maxDimension) {
            const scale = maxDimension / Math.max(targetWidth, targetHeight);
            targetWidth = Math.floor(targetWidth * scale / 2) * 2;
            targetHeight = Math.floor(targetHeight * scale / 2) * 2;
        }

        let videoBitrate = Math.min(originalBitrate * 0.8, 2500000);
        if (duration > 60) {
            videoBitrate = Math.min(videoBitrate, 1500000);
        } else if (duration > 30) {
            videoBitrate = Math.min(videoBitrate, 2000000);
        }

        const videoBitrateK = Math.floor(videoBitrate / 1000) + 'k';
        const maxrateK = Math.floor(videoBitrate * 1.5 / 1000) + 'k';
        const bufsizeK = Math.floor(videoBitrate * 2 / 1000) + 'k';

        const convertCmd = [
            'ffmpeg', '-y', '-i', `"${inputPath}"`,
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-profile:v', 'baseline',
            '-level', '3.1',
            '-pix_fmt', 'yuv420p',
            '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
            '-b:v', videoBitrateK,
            '-maxrate', maxrateK,
            '-bufsize', bufsizeK,
            '-g', '30',
            '-keyint_min', '30',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            '-f', 'mp4',
            `"${outputPath}"`
        ].join(' ');

        console.log('Converting video for WhatsApp compatibility');
        console.log(`Target: ${videoBitrateK} bitrate, ${targetWidth}x${targetHeight} resolution`);

        await execAsync(convertCmd, { 
            timeout: 300000,
            maxBuffer: 100 * 1024 * 1024
        });

        const stats = await fs.stat(outputPath);
        if (stats.size === 0) {
            throw new Error('Video conversion produced empty file');
        }

        console.log(`Video converted successfully: ${(stats.size / (1024 * 1024)).toFixed(1)}MB`);

    } catch (error) {
        console.error('Video conversion error:', error);
        throw new Error(`Video conversion failed: ${error.message}`);
    }
}

async function extractAudioFromVideo(videoUrl, outputPath, hdRequested) {
    try {
        try {
            await execAsync('ffmpeg -version', { timeout: 5000 });
        } catch (error) {
            throw new Error('ffmpeg not found. Please install ffmpeg for audio extraction.');
        }
        
        let command;
        if (hdRequested) {
            command = `ffmpeg -y -i "${videoUrl}" -vn -acodec mp3 -q:a 0 -ar 44100 -ac 2 -f mp3 "${outputPath}"`;
        } else {
            command = `ffmpeg -y -i "${videoUrl}" -vn -acodec mp3 -ab 256k -ar 44100 -ac 2 -f mp3 "${outputPath}"`;
        }
        
        await execAsync(command, { 
            timeout: 300000,
            maxBuffer: 50 * 1024 * 1024
        });
        
        const stats = await fs.stat(outputPath);
        if (stats.size === 0) {
            throw new Error('Audio extraction produced empty file');
        }
        
        if (stats.size > 100 * 1024 * 1024) {
            throw new Error('Extracted audio exceeds 100MB limit');
        }
        
    } catch (error) {
        throw new Error(`Audio extraction failed: ${error.message}`);
    }
}

function parseImageSelection(arg, max) {
    if (!arg) return [...Array(max).keys()];
    const parts = arg.split(/\s+/);
    const indices = new Set();
    for (const p of parts) {
        if (/^\d+$/.test(p)) {
            const i = parseInt(p) - 1;
            if (i >= 0 && i < max) indices.add(i);
        } else if (/^\d+-\d+$/.test(p)) {
            const [start, end] = p.split('-').map(x => parseInt(x));
            for (let i = start; i <= end; i++) {
                if (i >= 1 && i <= max) indices.add(i - 1);
            }
        }
    }
    return indices.size > 0 ? [...indices].sort((a, b) => a - b) : [...Array(max).keys()];
}

async function fetchTikTokMetadata(url, api) {
    try {
        const params = api.params(url);
        
        const response = await axios.get(api.url, {
            params: params,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': 'https://www.tiktok.com/',
                'Origin': 'https://www.tiktok.com'
            },
            timeout: 30000,
            validateStatus: (status) => status < 500
        });

        if (response.status === 429) {
            throw new Error('Rate limited');
        }

        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = api.parseData(response.data);
        if (!data) {
            throw new Error('No data in API response');
        }

        let result = null;

        if (data.images && data.images.length > 0) {
            result = {
                type: 'Images',
                title: sanitizeText(data.title || data.desc || 'TikTok Post'),
                description: sanitizeText(data.desc || ''),
                author: data.author?.nickname || data.author?.unique_id || data.author?.username || 'Unknown',
                images: data.images
            };
        }
        else if (data.hdplay || data.play || data.video_url || data.download_url) {
            const videoUrl = data.hdplay || data.play || data.video_url || data.download_url;
            result = {
                type: 'Video',
                title: sanitizeText(data.title || data.desc || 'TikTok Video'),
                author: data.author?.nickname || data.author?.unique_id || data.author?.username || 'Unknown',
                videoUrl: videoUrl
            };
        }

        if (!result) {
            throw new Error('Unsupported post type or no media found');
        }

        return result;

    } catch (error) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            throw new Error('Connection timeout');
        }
        if (error.response?.status === 429) {
            throw new Error('Rate limited');
        }
        if (error.response?.status === 403) {
            throw new Error('Access forbidden - video might be private');
        }
        if (error.response?.status === 404) {
            throw new Error('Video not found - might be deleted');
        }
        throw new Error(`API error: ${error.message}`);
    }
}

function sanitizeText(text) {
    if (!text || typeof text !== 'string') return 'Untitled';
    return text.substring(0, 100).replace(/[^\w\s.-]/g, '').trim() || 'Untitled';
}

function sanitizeFilename(text) {
    if (!text || typeof text !== 'string') return 'TikTok_Video';
    return text.substring(0, 50)
               .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
               .replace(/\s+/g, '_')
               .trim() || 'TikTok_Video';
}

async function downloadFile(url, filePath) {
    try {
        let lastError;
        const maxRetries = 3;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.get(url, { 
                    responseType: 'stream', 
                    timeout: 300000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Range': 'bytes=0-'
                    },
                    maxRedirects: 5
                });
                
                if (response.status !== 200 && response.status !== 206) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const writer = require('fs').createWriteStream(filePath);
                response.data.pipe(writer);
                
                return new Promise((resolve, reject) => {
                    let finished = false;
                    let bytesWritten = 0;
                    
                    writer.on('finish', async () => {
                        if (!finished) {
                            finished = true;
                            try {
                                const stats = await fs.stat(filePath);
                                if (stats.size === 0) {
                                    reject(new Error('Downloaded file is empty'));
                                } else {
                                    resolve();
                                }
                            } catch (error) {
                                reject(new Error('File verification failed'));
                            }
                        }
                    });
                    
                    writer.on('error', (error) => {
                        if (!finished) {
                            finished = true;
                            reject(error);
                        }
                    });
                    
                    response.data.on('data', (chunk) => {
                        bytesWritten += chunk.length;
                    });
                    
                    response.data.on('error', (error) => {
                        if (!finished) {
                            finished = true;
                            writer.destroy();
                            reject(error);
                        }
                    });
                    
                    setTimeout(() => {
                        if (!finished) {
                            finished = true;
                            writer.destroy();
                            reject(new Error(`Download timeout after 5 minutes (${bytesWritten} bytes written)`));
                        }
                    }, 300000);
                });

            } catch (error) {
                lastError = error;
                console.log(`Download attempt ${attempt}/${maxRetries} failed:`, error.message);
                
                if (attempt < maxRetries) {
                    await sleep(2000 * attempt);
                    continue;
                } else {
                    break;
                }
            }
        }
        
        throw lastError;
        
    } catch (error) {
        throw new Error(`Download failed after ${maxRetries} attempts: ${error.message}`);
    }
}

async function editMessage(msg, text) {
    try { 
        await msg.edit(text); 
    } catch (error) {
        console.log('Failed to edit message:', error.message);
    }
}

async function ensureDir(dir) {
    try { 
        await fs.mkdir(dir, { recursive: true }); 
    } catch (error) {
        console.log('Failed to create directory:', error.message);
    }
}

async function cleanup(files) {
    for (const file of files) {
        try { 
            await fs.unlink(file); 
        } catch (error) {
            console.log('Failed to cleanup file:', file, error.message);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}