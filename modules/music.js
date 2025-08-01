const { MessageMedia } = require('whatsapp-web.js');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const execAsync = promisify(exec);

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

module.exports = {
    name: 'music',
    description: 'Search and download music using Spotify metadata and YouTube',
    adminOnly: false,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        if (args.length === 0) {
            await message.reply('◉ Usage: .music <search query or Spotify URL>\n◉ Example: .music shape of you ed sheeran\n◉ Example: .music https://open.spotify.com/track/...');
            return;
        }

        const query = args.join(' ');
        const tempDir = path.join(__dirname, '../tmp');
        const timestamp = Date.now();
        
        let statusMessage = await message.reply('◉ Searching for music...');
        
        try {
            await ensureDir(tempDir);
            await authenticateSpotify();
            
            let trackInfo;
            if (query.includes('spotify.com/track/')) {
                await editMessage(statusMessage, '◉ Getting track info from Spotify...');
                trackInfo = await getSpotifyTrackFromUrl(query);
            } else {
                await editMessage(statusMessage, '◉ Searching Spotify...');
                trackInfo = await searchSpotifyTrack(query);
            }
            
            if (!trackInfo) {
                await editMessage(statusMessage, '✕ No results found on Spotify. Try different keywords.');
                return;
            }
            
            const { title, artist, album, duration, preview_url, image_url } = trackInfo;
            const displayTitle = `${artist} - ${title}`;
            const shortTitle = displayTitle.length > 50 ? displayTitle.substring(0, 47) + '...' : displayTitle;
            
            await editMessage(statusMessage, `◉ Found: ${shortTitle}\n◉ Album: ${album}\n◉ Duration: ${duration}\n◉ Searching YouTube...`);
            
            await editMessage(statusMessage, `◉ Found: ${shortTitle}\n◉ Album: ${album}\n◉ Duration: ${duration}\n◉ Finding best match on YouTube...`);
            
            const bestMatch = await findBestYouTubeMatch(trackInfo, query);
            
            if (!bestMatch) {
                await editMessage(statusMessage, '✕ No suitable YouTube match found. Try different keywords.');
                return;
            }
            
            const video = bestMatch;
            
            await editMessage(statusMessage, `◉ Found: ${shortTitle}\n◉ Album: ${album}\n◉ Duration: ${duration}\n◉ Downloading...`);
            
            const videoPath = path.join(tempDir, `${timestamp}_audio`);
            await downloadVideo(video.url, videoPath);
            
            await editMessage(statusMessage, `◉ Found: ${shortTitle}\n◉ Album: ${album}\n◉ Duration: ${duration}\n◉ Processing...`);
            
            const files = await fs.readdir(tempDir);
            const audioFile = files.find(file => 
                file.startsWith(`${timestamp}_audio`) && 
                (file.endsWith('.mp3') || file.endsWith('.m4a') || file.endsWith('.webm'))
            );
            
            if (!audioFile) {
                await editMessage(statusMessage, '✕ Download failed. File not found.');
                return;
            }
            
            const audioPath = path.join(tempDir, audioFile);
            let finalAudioPath = audioPath;
            
            if (!audioFile.endsWith('.mp3')) {
                await editMessage(statusMessage, `◉ Found: ${shortTitle}\n◉ Album: ${album}\n◉ Duration: ${duration}\n◉ Converting to MP3...`);
                finalAudioPath = path.join(tempDir, `${timestamp}_final.mp3`);
                await convertToMp3WithMetadata(audioPath, finalAudioPath, trackInfo);
            } else {
                const tempFinalPath = path.join(tempDir, `${timestamp}_final.mp3`);
                await addMetadataToMp3(audioPath, tempFinalPath, trackInfo);
                finalAudioPath = tempFinalPath;
            }
            
            await editMessage(statusMessage, `◉ Found: ${shortTitle}\n◉ Album: ${album}\n◉ Duration: ${duration}\n◉ Uploading...`);
            
            const audioBuffer = await fs.readFile(finalAudioPath);
            const audioMedia = new MessageMedia('audio/mpeg', audioBuffer.toString('base64'), `${artist} - ${title}.mp3`);
            
            await editMessage(statusMessage, `◉ ${shortTitle}\n◉ Album: ${album}\n◉ Duration: ${duration}\n◉ Ready!`);
            
            await message.reply(audioMedia);
            
            await cleanup([audioPath, finalAudioPath]);
            
        } catch (error) {
            let errorMsg = '✕ Download failed. Try with different keywords.';
            
            if (error.message.includes('Spotify')) {
                errorMsg = '✕ Spotify API error. Check your credentials.';
            } else if (error.message.includes('Search failed')) {
                errorMsg = '✕ Search failed. Check your internet connection.';
            }
            
            await editMessage(statusMessage, errorMsg);
            
            await cleanup([
                path.join(tempDir, `${timestamp}_audio.mp3`),
                path.join(tempDir, `${timestamp}_audio.m4a`),
                path.join(tempDir, `${timestamp}_audio.webm`),
                path.join(tempDir, `${timestamp}_final.mp3`)
            ]);
        }
    }
};

async function authenticateSpotify() {
    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body['access_token']);
    } catch (error) {
        throw new Error('Spotify authentication failed');
    }
}

async function searchSpotifyTrack(query) {
    try {
        const data = await spotifyApi.searchTracks(query, { limit: 1 });
        
        if (data.body.tracks.items.length === 0) {
            return null;
        }
        
        const track = data.body.tracks.items[0];
        
        return {
            title: track.name,
            artist: track.artists.map(artist => artist.name).join(', '),
            album: track.album.name,
            duration: formatDuration(Math.floor(track.duration_ms / 1000)),
            preview_url: track.preview_url,
            image_url: track.album.images[0]?.url,
            spotify_id: track.id,
            external_urls: track.external_urls
        };
    } catch (error) {
        return null;
    }
}

async function getSpotifyTrackFromUrl(url) {
    try {
        const trackId = url.match(/track\/([a-zA-Z0-9]+)/)?.[1];
        if (!trackId) {
            throw new Error('Invalid Spotify URL');
        }
        
        const data = await spotifyApi.getTrack(trackId);
        const track = data.body;
        
        return {
            title: track.name,
            artist: track.artists.map(artist => artist.name).join(', '),
            album: track.album.name,
            duration: formatDuration(Math.floor(track.duration_ms / 1000)),
            preview_url: track.preview_url,
            image_url: track.album.images[0]?.url,
            spotify_id: track.id,
            external_urls: track.external_urls
        };
    } catch (error) {
        return null;
    }
}

async function findBestYouTubeMatch(trackInfo, originalQuery = '') {
    const { title, artist, duration, album } = trackInfo;
    const targetDurationSeconds = parseDuration(duration);
    
    const cleanArtist = artist.replace(/[,&]/g, '').replace(/\s+/g, ' ').trim();
    const cleanTitle = title.replace(/[,&]/g, '').replace(/\s+/g, ' ').trim();
    const cleanAlbum = album.replace(/[,&]/g, '').replace(/\s+/g, ' ').trim();
    
    const isSpotifyUrl = originalQuery.includes('spotify.com/track/');
    const queryLower = originalQuery.toLowerCase();
    
    const userWants = {
        cover: queryLower.includes('cover'),
        remix: queryLower.includes('remix'),
        live: queryLower.includes('live'),
        acoustic: queryLower.includes('acoustic'),
        karaoke: queryLower.includes('karaoke'),
        instrumental: queryLower.includes('instrumental'),
        extended: queryLower.includes('extended') || queryLower.includes('extended mix'),
        radio: queryLower.includes('radio edit') || queryLower.includes('radio version')
    };
    
    let searchQueries = [];
    
    if (isSpotifyUrl) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} official`,
            `${cleanArtist} ${cleanTitle} official audio`,
            `${cleanArtist} ${cleanTitle} official video`,
            `${cleanArtist} ${cleanTitle}`,
            `${cleanTitle} ${cleanArtist}`,
            `${cleanArtist} ${cleanTitle} ${cleanAlbum}`
        ];
    } else if (userWants.cover) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} cover`,
            `${cleanTitle} ${cleanArtist} cover`,
            `${cleanTitle} cover`,
            `${cleanArtist} ${cleanTitle}`
        ];
    } else if (userWants.remix) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} remix`,
            `${cleanTitle} remix`,
            `${cleanArtist} ${cleanTitle}`
        ];
    } else if (userWants.live) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} live`,
            `${cleanTitle} live performance`,
            `${cleanArtist} live ${cleanTitle}`,
            `${cleanArtist} ${cleanTitle}`
        ];
    } else if (userWants.acoustic) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} acoustic`,
            `${cleanTitle} acoustic`,
            `${cleanArtist} ${cleanTitle}`
        ];
    } else if (userWants.instrumental) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} instrumental`,
            `${cleanTitle} instrumental`,
            `${cleanArtist} ${cleanTitle}`
        ];
    } else if (userWants.extended) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} extended`,
            `${cleanArtist} ${cleanTitle} extended mix`,
            `${cleanTitle} extended`,
            `${cleanArtist} ${cleanTitle}`
        ];
    } else if (userWants.radio) {
        searchQueries = [
            `${cleanArtist} ${cleanTitle} radio edit`,
            `${cleanArtist} ${cleanTitle} radio version`,
            `${cleanArtist} ${cleanTitle}`
        ];
    } else {
        const hasArtistInQuery = queryLower.includes(cleanArtist.toLowerCase());
        const hasTitleInQuery = queryLower.includes(cleanTitle.toLowerCase());
        
        if (hasArtistInQuery && hasTitleInQuery) {
            searchQueries = [
                `${cleanArtist} ${cleanTitle} official`,
                `${cleanArtist} ${cleanTitle} official audio`,
                `${cleanArtist} ${cleanTitle}`,
                `${cleanTitle} ${cleanArtist}`
            ];
        } else if (hasArtistInQuery) {
            searchQueries = [
                `${cleanArtist} ${cleanTitle} official`,
                `${cleanArtist} ${cleanTitle}`,
                originalQuery
            ];
        } else if (hasTitleInQuery) {
            searchQueries = [
                `${cleanArtist} ${cleanTitle} official`,
                `${cleanArtist} ${cleanTitle}`,
                originalQuery
            ];
        } else {
            searchQueries = [
                originalQuery,
                `${cleanArtist} ${cleanTitle} official`,
                `${cleanArtist} ${cleanTitle}`,
                `${cleanTitle} ${cleanArtist}`
            ];
        }
    }
    
    let allResults = [];
    
    for (const searchQuery of searchQueries) {
        try {
            const results = await searchYoutube(searchQuery, 10);
            if (results && results.length > 0) {
                allResults = allResults.concat(results.map(r => ({ ...r, searchQuery })));
            }
        } catch (error) {
            continue;
        }
    }
    
    if (allResults.length === 0) {
        return null;
    }
    
    const uniqueResults = [];
    const seenIds = new Set();
    
    for (const result of allResults) {
        if (!seenIds.has(result.id)) {
            seenIds.add(result.id);
            uniqueResults.push(result);
        }
    }
    
    const scoredResults = uniqueResults.map(result => {
        let score = 0;
        const resultTitle = result.title.toLowerCase();
        const resultUploader = result.uploader.toLowerCase();
        const artistLower = artist.toLowerCase();
        const titleLower = title.toLowerCase();
        
        if (resultTitle.includes('official') || resultUploader.includes('official')) {
            score += 50;
        }
        
        if (resultUploader.includes(artistLower) || 
            resultUploader.includes('records') || 
            resultUploader.includes('music') ||
            resultUploader.includes('entertainment') ||
            resultUploader.includes('official')) {
            score += 30;
        }
        
        if (isSpotifyUrl && (resultUploader.includes('vevo') || resultUploader.includes('official'))) {
            score += 40;
        }
        
        if (resultTitle.includes(artistLower) && resultTitle.includes(titleLower)) {
            score += 40;
        } else if (resultTitle.includes(titleLower)) {
            score += 20;
        }
        
        const userSearchedFor = {
            cover: queryLower.includes('cover'),
            remix: queryLower.includes('remix'), 
            live: queryLower.includes('live'),
            acoustic: queryLower.includes('acoustic'),
            karaoke: queryLower.includes('karaoke'),
            instrumental: queryLower.includes('instrumental'),
            extended: queryLower.includes('extended'),
            radio: queryLower.includes('radio')
        };
        
        const badWords = ['cover', 'remix', 'live', 'acoustic', 'karaoke', 'instrumental', 'reaction', 'tutorial', 'extended', 'radio edit'];
        for (const word of badWords) {
            if (resultTitle.includes(word)) {
                if (isSpotifyUrl && !userSearchedFor[word]) {
                    score -= 30;
                } else if (!userSearchedFor[word] && !userSearchedFor.hasOwnProperty(word)) {
                    score -= 25;
                } else if (userSearchedFor[word]) {
                    score += 35;
                }
            }
        }
        
        if (targetDurationSeconds > 0 && result.duration_seconds > 0) {
            const durationDiff = Math.abs(targetDurationSeconds - result.duration_seconds);
            if (durationDiff <= 10) {
                score += 30;
            } else if (durationDiff <= 30) {
                score += 15;
            } else if (durationDiff > 120) {
                score -= 20;
            }
        }
        
        score += Math.min(result.view_count / 1000000, 20);
        
        if (resultTitle.includes('hq') || resultTitle.includes('high quality') || resultTitle.includes('320')) {
            score += 10;
        }
        
        return { ...result, score };
    });
    
    scoredResults.sort((a, b) => b.score - a.score);
    
    return scoredResults[0] || null;
}

async function searchYoutube(query, limit = 5) {
    try {
        const cleanQuery = query.replace(/"/g, '').replace(/'/g, '').trim();
        const command = `yt-dlp --dump-json --flat-playlist --playlist-end ${limit} "ytsearch${limit}:${cleanQuery}"`;
        
        const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
        
        if (stderr && stderr.includes('ERROR')) {
        }
        
        if (!stdout || stdout.trim().length === 0) {
            throw new Error('No search results');
        }
        
        const lines = stdout.trim().split('\n');
        const results = [];
        
        for (const line of lines) {
            if (line.trim()) {
                try {
                    const data = JSON.parse(line);
                    if (data.id && data.title) {
                        results.push({
                            title: data.title || 'Unknown',
                            url: `https://www.youtube.com/watch?v=${data.id}`,
                            duration: formatDuration(data.duration),
                            duration_seconds: data.duration || 0,
                            uploader: data.uploader || data.channel || 'Unknown',
                            view_count: data.view_count || 0,
                            id: data.id
                        });
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        return results;
    } catch (error) {
        throw new Error(`Search failed: ${error.message}`);
    }
}

function parseDuration(durationStr) {
    if (!durationStr || durationStr === 'Unknown') return 0;
    
    const parts = durationStr.split(':').map(Number);
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    
    return 0;
}

async function downloadVideo(url, outputPath) {
    try {
        const command = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio" --extract-audio --audio-format mp3 --audio-quality 192K -o "${outputPath}.%(ext)s" "${url}"`;
        const { stdout, stderr } = await execAsync(command, { timeout: 300000 });
        
        if (stderr && stderr.includes('ERROR')) {
        }
        
        return stdout;
    } catch (error) {
        throw new Error(`Download failed: ${error.message}`);
    }
}

async function convertToMp3WithMetadata(inputPath, outputPath, trackInfo) {
    try {
        const possiblePaths = [
            inputPath,
            inputPath + '.mp3',
            inputPath + '.m4a',
            inputPath + '.webm'
        ];
        
        let actualInputPath = null;
        for (const p of possiblePaths) {
            try {
                await fs.access(p);
                actualInputPath = p;
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!actualInputPath) {
            throw new Error('No downloaded file found');
        }
        
        const { title, artist, album } = trackInfo;
        const metadataArgs = [
            `-metadata title="${title}"`,
            `-metadata artist="${artist}"`,
            `-metadata album="${album}"`,
            `-metadata genre="Music"`
        ].join(' ');
        
        const command = `ffmpeg -i "${actualInputPath}" -vn -acodec libmp3lame -ab 192k -ar 44100 ${metadataArgs} -y "${outputPath}"`;
        await execAsync(command, { timeout: 300000 });
        
    } catch (error) {
        throw new Error('Audio conversion failed');
    }
}

async function addMetadataToMp3(inputPath, outputPath, trackInfo) {
    try {
        const { title, artist, album } = trackInfo;
        const metadataArgs = [
            `-metadata title="${title}"`,
            `-metadata artist="${artist}"`,
            `-metadata album="${album}"`,
            `-metadata genre="Music"`
        ].join(' ');
        
        const command = `ffmpeg -i "${inputPath}" -c copy ${metadataArgs} -y "${outputPath}"`;
        await execAsync(command, { timeout: 60000 });
        
    } catch (error) {
        await fs.copyFile(inputPath, outputPath);
    }
}

async function editMessage(message, newText) {
    try {
        await message.edit(newText);
    } catch (error) {
    }
}

function formatDuration(seconds) {
    if (!seconds) return 'Unknown';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

async function ensureDir(dir) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (error) {
    }
}

async function cleanup(paths) {
    for (const filePath of paths) {
        try {
            await fs.unlink(filePath);
        } catch (error) {
        }
    }
}