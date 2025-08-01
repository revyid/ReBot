module.exports = {
    name: 'info',
    description: 'Show bot information',
    adminOnly: false,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        const info = client.info;
        const uptime = Math.floor((Date.now() - bot.startTime) / 1000);
        const memory = process.memoryUsage();
        const memUsed = (memory.heapUsed / 1024 / 1024).toFixed(2);
        const sysInfo = bot.getSystemInfo();
        
        const authInfo = bot.phoneNumber ? 
            `Pairing Code (+${bot.phoneNumber})` : 
            'QR Code';
        
        const text = `◐ *Bot Information*
◐ Name: ${info.pushname}
◐ Number: ${info.wid.user}
◐ Distro: ${sysInfo.distro}
◐ Platform: ${sysInfo.platform}/${sysInfo.arch}
◐ CPU: ${sysInfo.cpu}
◐ Cores: ${sysInfo.cpuCores}
◐ RAM: ${memUsed}MB / ${sysInfo.totalMemory}GB
◐ Uptime: ${uptime}s
◐ Total Users: ${bot.users.size}
◐ Messages Processed: ${bot.messageCount}`

        await message.reply(text);
    }
};
