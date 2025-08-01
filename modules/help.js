module.exports = {
    name: 'help',
    description: 'Show available commands',
    adminOnly: false,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        const commands = [];
        for (const [name, module] of bot.modules) {
            if (module.hideFromList || module.adminOnly) continue;
            commands.push(`◐ .${name} - ${module.description}`);
        }
        const text = `◐ *Available Commands*\n\n${commands.join('\n')}\n\n◐ Total Commands: ${commands.length}`;
        await message.reply(text);
    }
};