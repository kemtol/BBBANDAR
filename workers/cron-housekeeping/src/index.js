/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

async function deleteOldFiles(env, prefix, daysOld) {
    let truncated = true;
    let cursor = undefined;
    let deletedCount = 0;
    let totalSize = 0;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    console.log(`[Housekeeping] Deleting files in '${prefix}' older than ${cutoffDate.toISOString()}`);

    while (truncated) {
        const list = await env.SSSAHAM_EMITEN.list({
            prefix,
            cursor,
            limit: 1000,
        });

        const keysToDelete = [];
        for (const obj of list.objects) {
            const uploadedDate = obj.uploaded;
            if (uploadedDate < cutoffDate) {
                keysToDelete.push(obj.key);
                deletedCount++;
                totalSize += obj.size;
            }
        }

        if (keysToDelete.length > 0) {
            await env.SSSAHAM_EMITEN.delete(keysToDelete);
            console.log(`[Housekeeping] Deleted ${keysToDelete.length} files from '${prefix}'.`);
        }

        truncated = list.truncated;
        cursor = list.cursor;
    }

    return { deletedCount, totalSize };
}


export default {
    async scheduled(event, env, ctx) {
        console.log(`[Housekeeping] Cron triggered at ${new Date()}`);

        const daysOld = 7;

        const screenshotResult = await deleteOldFiles(env, 'ai-screenshots/', daysOld);
        console.log(`[Housekeeping] Screenshots: Deleted ${screenshotResult.deletedCount} files, totaling ${(screenshotResult.totalSize / 1024 / 1024).toFixed(2)} MB.`);

        const cacheResult = await deleteOldFiles(env, 'ai-cache/', daysOld);
        console.log(`[Housekeeping] Cache: Deleted ${cacheResult.deletedCount} files, totaling ${(cacheResult.totalSize / 1024 / 1024).toFixed(2)} MB.`);

        console.log('[Housekeeping] Cron finished.');
    },
};
