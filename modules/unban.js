module.exports = {
    name: 'unban',
    description: 'Unban a user (provide number)',
    adminOnly: true,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        if (args.length === 0) {
            return await message.reply('◑ Provide a phone number to unban');
        }
        const userId = args[0].replace(/D/g, '');
        if (bot.bannedUsers.has(userId)) {
            bot.bannedUsers.delete(userId);
            bot.saveBannedUsers();
            await message.reply(`◐ User ${userId} has been unbanned`);
            bot.log(`User unbanned: ${userId}`);
        } else {
            await message.reply('◑ User not found in ban list');
        }
    }
};