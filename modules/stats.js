module.exports = {
    name: 'stats',
    description: 'Show detailed bot statistics',
    adminOnly: true,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        const uptime = Math.floor((Date.now() - bot.startTime) / 1000);
        const memory = process.memoryUsage();
        const memUsed = (memory.heapUsed / 1024 / 1024).toFixed(2);
        const memTotal = (memory.heapTotal / 1024 / 1024).toFixed(2);
        const info = client.info;
        const sysInfo = bot.getSystemInfo();
        const authInfo = bot.phoneNumber
            ? `Pairing Code (+${bot.phoneNumber})`
            : 'QR Code';

        // Fix: Get the actual sender ID consistently
        const senderId = message.from.endsWith('@g.us') ? message.author : message.from;
        
        // Fix: Clean the sender ID to match stored format
        const cleanSenderId = senderId.replace('@c.us', '').replace('@s.whatsapp.net', '');
        
        // Fix: Try to get user data with different ID formats
        let userData = bot.users.get(senderId) || bot.users.get(cleanSenderId) || bot.users.get(senderId.split('@')[0]);
        
        // Fix: Check admin status with consistent ID format
        const isAdmin = bot.admins.has(senderId) || bot.admins.has(cleanSenderId) || bot.admins.has(senderId.split('@')[0]);
        
        const userName = userData?.name || '(no name)';
        const messageCount = userData?.messageCount ?? '-';

        const recentUsers = Array.from(bot.users.entries())
            .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
            .slice(0, 10)
            .map(([id, user]) => {
                // Fix: Check admin status with consistent ID comparison
                const cleanId = id.replace('@c.us', '').replace('@s.whatsapp.net', '');
                const userIsAdmin = bot.admins.has(id) || bot.admins.has(cleanId) || bot.admins.has(id.split('@')[0]);
                const mark = userIsAdmin ? '⚠' : '◉';
                return `${mark} ${user.name || '(no name)'} (${user.messageCount || 0} msgs)`;
            })
            .join('\n') || 'No recent users.';

        const adminList = Array.from(bot.admins)
            .map((id) => {
                // Fix: Try to find user data with different ID formats
                const cleanId = id.replace('@c.us', '').replace('@s.whatsapp.net', '');
                const user = bot.users.get(id) || bot.users.get(cleanId) || bot.users.get(id.split('@')[0]);
                const name = user?.name || '(no name)';
                const msgs = user?.messageCount ?? '-';
                return `⚑ ${name} (${cleanId}) - ${msgs} msgs`;
            })
            .join('\n') || 'None';

        const text = `⚠ *Bot Statistics*

◉ *System Info:*
• Uptime: ${uptime}s
• CPU: ${sysInfo.cpu} (${sysInfo.cpuCores} cores)
• Memory: ${memUsed}MB / ${memTotal}MB
• Platform: ${sysInfo.platform}/${sysInfo.arch}
• Distro: ${sysInfo.distro}

◉ *Bot Status:*
• Total Users: ${bot.users.size}
• Messages Processed: ${bot.messageCount}
• Modules Loaded: ${bot.modules.size}
• Admins Registered: ${bot.admins.size}
• Session ID: ${bot.sessionId}
• Auth Method: ${authInfo}

◉ *You (Command Sender):*
• Name: ${userName}
• ID: ${cleanSenderId || senderId}
• Admin: ${isAdmin ? 'Yes' : 'No'}
• Messages Sent: ${messageCount}

◉ *Recent Users:*
${recentUsers}

◉ *Admin List:*
${adminList}`;

        await message.reply(text);
    }
};