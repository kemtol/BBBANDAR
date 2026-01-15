/**
 * @worker batch-delete
 * @objective Manages large-scale R2 object deletion via synchronous calls or asynchronous queues, supporting recursive deletion by prefix and bulk key deletion.
 *
 * @endpoints
 * - POST /queue-delete -> Queues a background deletion job (fire-and-forget) (public/internal)
 * - GET /job-status?id=... -> Checks progress of a queued deletion job (public/internal)
 * - GET /list -> Lists objects for preview (public/internal)
 * - DELETE /delete -> Synchronous deletion (timeout risk for large sets) (public/internal)
 * - POST /delete-keys -> Bulk deletion of specific keys (public/internal)
 * - GET / -> Help/Usage info (public)
 *
 * @triggers
 * - http: yes
 * - cron: none
 * - queue: deletion-queue (Handler implemented as 'queue', but binding not visible in provided config snippet. Check wrangler.toml)
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: R2 (TAPE_DATA_FUTURES, TAPE_DATA_SAHAM), KV (JOB_STATUS)
 * - writes: R2 (Delete interactions), KV (JOB_STATUS)
 *
 * @relations
 * - upstream: Admin/Ops or Automated Workflows
 * - downstream: none
 *
 * @success_metrics
 * - Deletion throughput
 * - Job completion rate
 *
 * @notes
 * - Uses KV (JOB_STATUS) to track async job progress.
 * - Supports two buckets: 'futures' and 'saham'.
 */
// batch-delete/src/index.js
// Worker untuk batch delete files/objects di R2 secara recursive
// Now with Cloudflare Queues support for background processing

/**
 * List all objects with a given prefix (for preview before delete)
 */
async function listObjects(bucket, prefix, maxResults = 1000) {
    const objects = [];
    let cursor = undefined;
    let truncated = false;

    while (objects.length < maxResults) {
        const listed = await bucket.list({
            prefix,
            cursor,
            limit: Math.min(1000, maxResults - objects.length)
        });

        objects.push(...listed.objects);

        if (!listed.truncated) {
            break;
        }

        cursor = listed.cursor;

        if (objects.length >= maxResults) {
            truncated = true;
            break;
        }
    }

    return {
        objects: objects.map(obj => ({
            key: obj.key,
            size: obj.size,
            uploaded: obj.uploaded
        })),
        total: objects.length,
        truncated
    };
}

/**
 * Delete all objects with a given prefix (recursive)
 */
async function deleteRecursive(bucket, prefix) {
    let deleted = 0;
    let errors = [];
    let cursor = undefined;

    while (true) {
        const listed = await bucket.list({
            prefix,
            cursor,
            limit: 1000
        });

        for (const object of listed.objects) {
            try {
                await bucket.delete(object.key);
                deleted++;
            } catch (err) {
                errors.push({
                    key: object.key,
                    error: err.message
                });
            }
        }

        if (!listed.truncated) {
            break;
        }

        cursor = listed.cursor;
    }

    return { deleted, errors };
}

/**
 * Generate a simple confirmation token based on prefix
 */
function generateConfirmToken(prefix) {
    const hash = Array.from(prefix).reduce((hash, char) => {
        return ((hash << 5) - hash) + char.charCodeAt(0);
    }, 0);
    return Math.abs(hash).toString(36);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const getBucket = () => {
            const bucketName = url.searchParams.get('bucket') || 'futures';
            switch (bucketName) {
                case 'futures':
                    return env.TAPE_DATA_FUTURES;
                case 'saham':
                    return env.TAPE_DATA_SAHAM;
                default:
                    throw new Error(`Unknown bucket: ${bucketName}`);
            }
        };

        try {
            // POST /queue-delete - Queue deletion job (fire and forget)
            if (path === '/queue-delete' && request.method === 'POST') {
                const prefix = url.searchParams.get('prefix');
                const bucket = url.searchParams.get('bucket') || 'futures';

                if (!prefix) {
                    return Response.json({ error: 'Missing required parameter: prefix' }, { status: 400, headers: corsHeaders });
                }

                const jobId = `delete-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

                await env.DELETION_QUEUE.send({
                    jobId,
                    prefix,
                    bucket,
                    timestamp: new Date().toISOString()
                });

                await env.JOB_STATUS.put(jobId, JSON.stringify({
                    jobId,
                    prefix,
                    bucket,
                    status: 'queued',
                    progress: 0,
                    deleted: 0,
                    createdAt: new Date().toISOString()
                }), { expirationTtl: 86400 });

                return Response.json({
                    success: true,
                    jobId,
                    prefix,
                    bucket,
                    status: 'queued',
                    message: `Deletion job queued. Check status: GET /job-status?id=${jobId}`,
                    statusUrl: `/job-status?id=${jobId}`
                }, { headers: corsHeaders });
            }

            // GET /job-status - Check job status
            if (path === '/job-status' && request.method === 'GET') {
                const jobId = url.searchParams.get('id');

                if (!jobId) {
                    return Response.json({ error: 'Missing parameter: id' }, { status: 400, headers: corsHeaders });
                }

                const status = await env.JOB_STATUS.get(jobId);

                if (!status) {
                    return Response.json({
                        error: 'Job not found',
                        jobId
                    }, { status: 404, headers: corsHeaders });
                }

                return new Response(status, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }

            // GET /list - List objects
            if (path === '/list' && request.method === 'GET') {
                const prefix = url.searchParams.get('prefix');
                const maxResults = parseInt(url.searchParams.get('max') || '1000', 10);
                const bucketName = url.searchParams.get('bucket') || 'futures';

                if (!prefix) {
                    return Response.json({ error: 'Missing required parameter: prefix' }, { status: 400, headers: corsHeaders });
                }

                const bucket = getBucket();
                const result = await listObjects(bucket, prefix, maxResults);
                const confirmToken = generateConfirmToken(prefix);

                return Response.json({
                    prefix,
                    bucket: bucketName,
                    ...result,
                    confirm_token: confirmToken
                }, { headers: corsHeaders });
            }

            // DELETE /delete - Synchronous delete (may timeout)
            if (path === '/delete' && request.method === 'DELETE') {
                const prefix = url.searchParams.get('prefix');
                const confirmToken = url.searchParams.get('confirm');
                const bucketName = url.searchParams.get('bucket') || 'futures';

                if (!prefix) {
                    return Response.json({ error: 'Missing required parameter: prefix' }, { status: 400, headers: corsHeaders });
                }

                if (!confirmToken) {
                    return Response.json({ error: 'Missing confirmation token' }, { status: 400, headers: corsHeaders });
                }

                const expectedToken = generateConfirmToken(prefix);
                if (confirmToken !== expectedToken) {
                    return Response.json({ error: 'Invalid confirmation token' }, { status: 403, headers: corsHeaders });
                }

                const bucket = getBucket();
                const startTime = Date.now();
                const result = await deleteRecursive(bucket, prefix);
                const duration = Date.now() - startTime;

                return Response.json({
                    success: true,
                    prefix,
                    bucket: bucketName,
                    deleted: result.deleted,
                    errors: result.errors.length > 0 ? result.errors : undefined,
                    duration_ms: duration,
                    note: 'For large deletions, use POST /queue-delete instead'
                }, { headers: corsHeaders });
            }

            // GET / - Help
            if (path === '/' && request.method === 'GET') {
                return Response.json({
                    name: 'Batch Delete Worker with Queue Support',
                    endpoints: {
                        'POST /queue-delete': 'Queue deletion job (recommended)',
                        'GET /job-status': 'Check job status',
                        'GET /list': 'List objects (preview)',
                        'DELETE /delete': 'Synchronous delete (may timeout)'
                    },
                    usage: 'POST /queue-delete?prefix=raw_lt/2025/12/05/&bucket=saham'
                }, { headers: corsHeaders });
            }

            // DELETE /delete-keys - Bulk delete specific keys
            if (path === '/delete-keys' && request.method === 'POST') {
                const bucketName = url.searchParams.get('bucket') || 'futures';
                const bucket = getBucket();

                let keys = [];
                try {
                    const body = await request.json();
                    if (Array.isArray(body.keys)) {
                        keys = body.keys;
                    }
                } catch (e) {
                    return Response.json({ error: 'Invalid JSON body or missing "keys" array' }, { status: 400, headers: corsHeaders });
                }

                if (!keys.length) {
                    return Response.json({ success: true, deleted: 0, message: "No keys provided" }, { headers: corsHeaders });
                }

                // Delete in badges of 1000 (limit is implicit by promise.all but let's be safe)
                // Actually R2 delete is one by one or via delete(key). 
                // We'll use Promise.all with some concurrency control if needed, 
                // but for ~50 keys it's fine.

                const results = {
                    success: [],
                    failed: []
                };

                // Helper for batching promises
                const batchSize = 50;
                for (let i = 0; i < keys.length; i += batchSize) {
                    const chunk = keys.slice(i, i + batchSize);
                    await Promise.all(chunk.map(async (key) => {
                        try {
                            await bucket.delete(key);
                            results.success.push(key);
                        } catch (err) {
                            results.failed.push({ key, error: err.message });
                        }
                    }));
                }

                return Response.json({
                    success: true,
                    bucket: bucketName,
                    deletedCount: results.success.length,
                    failedCount: results.failed.length,
                    failed: results.failed.length > 0 ? results.failed : undefined
                }, { headers: corsHeaders });
            }

            return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });

        } catch (err) {
            return Response.json({
                error: 'Internal server error',
                message: err.message
            }, { status: 500, headers: corsHeaders });
        }
    },

    /**
     * Queue consumer - processes deletion jobs in background
     */
    async queue(batch, env) {
        console.log(`Processing ${batch.messages.length} deletion jobs`);

        for (const message of batch.messages) {
            const { jobId, prefix, bucket } = message.body;

            console.log(`Starting job ${jobId}: ${prefix}`);

            try {
                await env.JOB_STATUS.put(jobId, JSON.stringify({
                    jobId,
                    prefix,
                    bucket,
                    status: 'processing',
                    progress: 0,
                    deleted: 0,
                    startedAt: new Date().toISOString()
                }), { expirationTtl: 86400 });

                const bucketInstance = bucket === 'saham' ? env.TAPE_DATA_SAHAM : env.TAPE_DATA_FUTURES;

                let totalDeleted = 0;
                let cursor = undefined;

                while (true) {
                    const listed = await bucketInstance.list({
                        prefix,
                        cursor,
                        limit: 1000
                    });

                    for (const object of listed.objects) {
                        try {
                            await bucketInstance.delete(object.key);
                            totalDeleted++;

                            if (totalDeleted % 100 === 0) {
                                await env.JOB_STATUS.put(jobId, JSON.stringify({
                                    jobId,
                                    prefix,
                                    bucket,
                                    status: 'processing',
                                    progress: totalDeleted,
                                    deleted: totalDeleted,
                                    lastUpdate: new Date().toISOString()
                                }), { expirationTtl: 86400 });
                            }
                        } catch (err) {
                            console.error(`Failed to delete ${object.key}:`, err);
                        }
                    }

                    if (!listed.truncated) {
                        break;
                    }

                    cursor = listed.cursor;
                }

                await env.JOB_STATUS.put(jobId, JSON.stringify({
                    jobId,
                    prefix,
                    bucket,
                    status: 'completed',
                    progress: totalDeleted,
                    deleted: totalDeleted,
                    completedAt: new Date().toISOString()
                }), { expirationTtl: 86400 });

                console.log(`✅ Job ${jobId} completed: ${totalDeleted} files`);

                message.ack();

            } catch (err) {
                console.error(`❌ Job ${jobId} failed:`, err);

                await env.JOB_STATUS.put(jobId, JSON.stringify({
                    jobId,
                    prefix,
                    bucket,
                    status: 'failed',
                    error: err.message,
                    failedAt: new Date().toISOString()
                }), { expirationTtl: 86400 });

                message.retry();
            }
        }
    }
};
