module.exports = {
    name: 'cadmin',
    description: 'Show admin commands (hidden)',
    adminOnly: true,
    hideFromList: true,
    execute: async (message, args, client, bot) => {
        const adminCommands = [];
        for (const [name, module] of bot.modules) {
            if (module.adminOnly) {
                adminCommands.push(`◑ .${name} - ${module.description}`);
            }
        }
        const text = `◑ *Admin Commands*\n\n${adminCommands.join('\n')}\n\n◑ Total Admin Commands: ${adminCommands.length}`;
        await message.reply(text);
    }
};