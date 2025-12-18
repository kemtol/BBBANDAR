#!/bin/bash
# Test script for batch-delete worker

# Configuration
# WORKER_URL="https://batch-delete.YOUR_WORKER.workers.dev"  # Replace with your worker URL
WORKER_URL="http://localhost:8787"  # For local testing

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Batch Delete Worker Test ===${NC}\n"

# Test 1: Get help
echo -e "${GREEN}Test 1: GET / (Help)${NC}"
curl -s "$WORKER_URL/" | jq '.'
echo -e "\n"

# Test 2: List objects (replace with actual prefix)
PREFIX="futures/raw_MNQ/"
echo -e "${GREEN}Test 2: GET /list?prefix=${PREFIX}${NC}"
RESPONSE=$(curl -s "$WORKER_URL/list?prefix=$PREFIX")
echo "$RESPONSE" | jq '.'

# Extract confirm token
CONFIRM_TOKEN=$(echo "$RESPONSE" | jq -r '.confirm_token')
echo -e "\n${YELLOW}Confirmation Token: $CONFIRM_TOKEN${NC}\n"

# Test 3: Try to delete without token (should fail)
echo -e "${GREEN}Test 3: DELETE without token (should fail)${NC}"
curl -s -X DELETE "$WORKER_URL/delete?prefix=$PREFIX" | jq '.'
echo -e "\n"

# Test 4: Try to delete with wrong token (should fail)
echo -e "${GREEN}Test 4: DELETE with wrong token (should fail)${NC}"
curl -s -X DELETE "$WORKER_URL/delete?prefix=$PREFIX&confirm=wrongtoken" | jq '.'
echo -e "\n"

# Test 5: Delete with correct token (uncomment to actually delete)
# echo -e "${RED}Test 5: DELETE with correct token (WILL DELETE DATA!)${NC}"
# read -p "Are you sure you want to delete all objects with prefix '$PREFIX'? (yes/no): " confirm
# if [ "$confirm" == "yes" ]; then
#     curl -s -X DELETE "$WORKER_URL/delete?prefix=$PREFIX&confirm=$CONFIRM_TOKEN" | jq '.'
# else
#     echo "Deletion cancelled."
# fi

echo -e "\n${YELLOW}=== Test Complete ===${NC}"
echo -e "To actually delete data, uncomment Test 5 in the script."
