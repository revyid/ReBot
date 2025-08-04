module.exports = {
    name: 'ping',
    description: 'Test command to check bot responsiveness',
    adminOnly: false,
    hideFromList: false,
    
    async execute(message, args, client, bot) {
        const startTime = Date.now();
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const responseTime = Date.now() - startTime;
        const uptime = Math.floor((Date.now() - bot.startTime) / 1000);
        const memory = process.memoryUsage();
        const memUsed = (memory.heapUsed / 1024 / 1024).toFixed(2);
        
        const response = `🏓 Pong!\n` +
                        `📊 Response: ${responseTime}ms\n` +
                        `⏱️ Uptime: ${uptime}s\n` +
                        `💾 Memory: ${memUsed}MB\n` +
                        `🔄 Tasks: ${bot.runningTasks.size}/${bot.maxConcurrentTasks}\n` +
                        `📝 Queue: ${bot.messageQueue.length}`;
        
        await message.reply(response);
    }
};