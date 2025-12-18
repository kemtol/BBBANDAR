# Batch Delete Worker

Worker untuk batch delete files/objects di R2 secara recursive dengan safety confirmation.

## Features

✅ **Recursive Deletion** - Automatically deletes all objects matching a prefix  
✅ **Preview First** - List objects before deleting  
✅ **Safety Confirmation** - Requires confirmation token to prevent accidental deletion  
✅ **Pagination Handling** - Handles buckets with >1000 objects automatically  
✅ **Error Logging** - Reports any errors during deletion  
✅ **CORS Enabled** - Can be called from browser

## Endpoints

### `GET /` - Help & Documentation
Returns API documentation and usage examples.

### `GET /list?prefix=xxx` - Preview Objects
List all objects matching the prefix before deletion.

**Parameters:**
- `prefix` (required) - R2 object prefix (e.g., `futures/raw_MNQ/`)
- `max` (optional) - Maximum results to return (default: 1000)

**Response:**
```json
{
  "prefix": "futures/raw_MNQ/",
  "objects": [
    {
      "key": "futures/raw_MNQ/daily/2024/12/20241215.json",
      "size": 1234,
      "uploaded": "2024-12-15T10:00:00.000Z"
    }
  ],
  "total": 150,
  "truncated": false,
  "confirm_token": "abc123",
  "note": "Found 150 objects. Use DELETE endpoint with confirm_token to proceed."
}
```

### `DELETE /delete?prefix=xxx&confirm=token` - Delete Objects
Delete all objects matching the prefix (recursive).

**Parameters:**
- `prefix` (required) - R2 object prefix to delete
- `confirm` (required) - Confirmation token from `/list` endpoint

**Response:**
```json
{
  "success": true,
  "prefix": "futures/raw_MNQ/",
  "deleted": 150,
  "duration_ms": 2345,
  "timestamp": "2024-12-17T05:15:00.000Z"
}
```

## Usage Workflow

1. **Preview** - Call `/list` to see what will be deleted:
   ```bash
   curl "https://batch-delete.YOUR_WORKER.workers.dev/list?prefix=futures/raw_MNQ/"
   ```

2. **Get Token** - Note the `confirm_token` from response

3. **Delete** - Call `/delete` with the confirmation token:
   ```bash
   curl -X DELETE "https://batch-delete.YOUR_WORKER.workers.dev/delete?prefix=futures/raw_MNQ/&confirm=TOKEN"
   ```

4. **Review** - Check the deletion results

## Deployment

```bash
# Deploy to Cloudflare Workers
npm install -g wrangler
wrangler deploy
```

## Configuration

Pastikan `wrangler.toml` sudah configured dengan R2 bucket binding:

```toml
name = "batch-delete"
main = "src/index.js"
compatibility_date = "2024-12-17"

[[r2_buckets]]
binding = "TAPE_DATA_FUTURES"
bucket_name = "your-bucket-name"
```

## Safety Features

- **Confirmation Required** - Cannot delete without first listing and getting token
- **Token Validation** - Tokens are prefix-specific
- **Error Handling** - Continues deletion even if individual items fail
- **Transparency** - Returns count of deleted items and any errors

## Examples

### Cleanup old raw futures data
```bash
# Preview
curl "https://batch-delete.YOUR_WORKER.workers.dev/list?prefix=futures/raw_MNQ/"

# Delete
curl -X DELETE "https://batch-delete.YOUR_WORKER.workers.dev/delete?prefix=futures/raw_MNQ/&confirm=TOKEN"
```

### Cleanup specific date range
```bash
# Preview specific year
curl "https://batch-delete.YOUR_WORKER.workers.dev/list?prefix=futures/raw_MGC/daily/2023/"

# Delete with confirmation
curl -X DELETE "https://batch-delete.YOUR_WORKER.workers.dev/delete?prefix=futures/raw_MGC/daily/2023/&confirm=TOKEN"
```

## Notes

- Deletes are **permanent** - R2 doesn't have a recycle bin
- Always preview with `/list` first
- For large deletions (>10k objects), the operation may take time
- The worker will handle pagination automatically
