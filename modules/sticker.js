const { MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs').promises;
const path = require('path');

module.exports = {
    name: 'sticker',
    description: 'Convert images, videos, gifs or text to sticker',
    adminOnly: false,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        try {
            if (message.hasMedia) {
                const media = await message.downloadMedia();
                let stickerBuffer;

                if (media.mimetype.startsWith('image/')) {
                    if (media.mimetype === 'image/gif') {
                        stickerBuffer = await processGifToSticker(media.data);
                    } else {
                        stickerBuffer = await processImageToSticker(media.data);
                    }
                } else if (media.mimetype.startsWith('video/')) {
                    stickerBuffer = await processVideoToSticker(media.data);
                } else {
                    await message.reply('✕ Unsupported media type. Use image, gif, or video.');
                    return;
                }

                const stickerMedia = new MessageMedia('image/webp', stickerBuffer.toString('base64'));
                await message.reply(stickerMedia, undefined, { sendMediaAsSticker: true });

            } else if (args.length > 0) {
                const text = args.join(' ');
                const options = parseTextOptions(text);
                const stickerBuffer = await createTextSticker(options);
                const stickerMedia = new MessageMedia('image/webp', stickerBuffer.toString('base64'));
                await message.reply(stickerMedia, undefined, { sendMediaAsSticker: true });

            } else {
                await message.reply('◉ Usage:\n• Reply to image/gif/video with .sticker\n• .sticker <text> [options]\n\n◉ Text options:\n• --size <number> (default: 48)\n• --font <name> (default: Arial)\n• --color <hex> (default: #000000)\n• --bg <hex> (background color)\n• --x <number> (horizontal position)\n• --y <number> (vertical position)\n• --width <number> (canvas width, default: 512)\n• --height <number> (canvas height, default: 512)\n\n◉ Example:\n/sticker Hello World --size 60 --color #ff0000 --bg #ffffff');
            }
        } catch (error) {
            console.error('Sticker creation error:', error);
            await message.reply('✕ Failed to create sticker. Please try again.');
        }
    }
};

async function processImageToSticker(imageData) {
    const buffer = Buffer.from(imageData, 'base64');
    return await sharp(buffer)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 90 })
        .toBuffer();
}

async function processGifToSticker(gifData) {
    const buffer = Buffer.from(gifData, 'base64');
    const tempGifPath = path.join(__dirname, `temp_${Date.now()}.gif`);
    const tempWebpPath = path.join(__dirname, `temp_${Date.now()}.webp`);

    try {
        await fs.writeFile(tempGifPath, buffer);

        await new Promise((resolve, reject) => {
            ffmpeg(tempGifPath)
                .outputOptions([
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                    '-loop', '0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0'
                ])
                .toFormat('webp')
                .on('error', reject)
                .on('end', resolve)
                .save(tempWebpPath);
        });

        const result = await fs.readFile(tempWebpPath);
        await cleanup([tempGifPath, tempWebpPath]);
        return result;
    } catch (error) {
        await cleanup([tempGifPath, tempWebpPath]);
        throw error;
    }
}

async function processVideoToSticker(videoData) {
    const buffer = Buffer.from(videoData, 'base64');
    const tempVideoPath = path.join(__dirname, `temp_${Date.now()}.mp4`);
    const tempWebpPath = path.join(__dirname, `temp_${Date.now()}.webp`);

    try {
        await fs.writeFile(tempVideoPath, buffer);

        await new Promise((resolve, reject) => {
            ffmpeg(tempVideoPath)
                .outputOptions([
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                    '-loop', '0',
                    '-t', '6',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0'
                ])
                .toFormat('webp')
                .on('error', reject)
                .on('end', resolve)
                .save(tempWebpPath);
        });

        const result = await fs.readFile(tempWebpPath);
        await cleanup([tempVideoPath, tempWebpPath]);
        return result;
    } catch (error) {
        await cleanup([tempVideoPath, tempWebpPath]);
        throw error;
    }
}

async function createTextSticker(options) {
    const canvas = createCanvas(options.width, options.height);
    const ctx = canvas.getContext('2d');

    if (options.background) {
        ctx.fillStyle = options.background;
        ctx.fillRect(0, 0, options.width, options.height);
    }

    ctx.fillStyle = options.color;
    ctx.font = `${options.size}px ${options.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = options.text.split('\n');
    const lineHeight = options.size * 1.2;
    const totalHeight = lines.length * lineHeight;
    const startY = options.y !== null ? options.y : (options.height - totalHeight) / 2 + options.size / 2;

    lines.forEach((line, index) => {
        const y = startY + index * lineHeight;
        const x = options.x !== null ? options.x : options.width / 2;
        ctx.fillText(line, x, y);
    });

    const buffer = canvas.toBuffer('image/png');
    return await sharp(buffer)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 90 })
        .toBuffer();
}

function parseTextOptions(input) {
    const options = {
        text: '',
        size: 48,
        font: 'Arial',
        color: '#000000',
        background: null,
        x: null,
        y: null,
        width: 512,
        height: 512
    };

    const args = input.split(' ');
    let textParts = [];
    let i = 0;

    while (i < args.length) {
        const arg = args[i];
        
        if (arg.startsWith('--')) {
            const option = arg.substring(2);
            const value = args[i + 1];
            
            switch (option) {
                case 'size':
                    options.size = parseInt(value) || 48;
                    i += 2;
                    break;
                case 'font':
                    options.font = value || 'Arial';
                    i += 2;
                    break;
                case 'color':
                    options.color = value || '#000000';
                    i += 2;
                    break;
                case 'bg':
                    options.background = value;
                    i += 2;
                    break;
                case 'x':
                    options.x = parseInt(value);
                    i += 2;
                    break;
                case 'y':
                    options.y = parseInt(value);
                    i += 2;
                    break;
                case 'width':
                    options.width = parseInt(value) || 512;
                    i += 2;
                    break;
                case 'height':
                    options.height = parseInt(value) || 512;
                    i += 2;
                    break;
                default:
                    textParts.push(arg);
                    i++;
            }
        } else {
            textParts.push(arg);
            i++;
        }
    }

    options.text = textParts.join(' ');
    return options;
}

async function cleanup(paths) {
    for (const filePath of paths) {
        try {
            await fs.unlink(filePath);
        } catch (error) {
            console.error(`Failed to delete ${filePath}:`, error);
        }
    }
}