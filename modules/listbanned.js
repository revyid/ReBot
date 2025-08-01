module.exports = {
    name: 'listbanned',
    description: 'List all banned users',
    adminOnly: true,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        let bannedList = '◑ *Banned Users:*\n\n';
        let count = 1;
        for (const userId of bot.bannedUsers) {
            const user = bot.users.get(userId);
            const name = user ? user.name : userId;
            bannedList += `${count}. ${name} (${userId})\n`;
            count++;
        }
        bannedList += `\n◐ Total Banned: ${bot.bannedUsers.size}`;
        await message.reply(bannedList);
    }
};