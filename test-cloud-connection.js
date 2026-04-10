#!/usr/bin/env node
/**
 * Simple Cloud API Connection Test
 * Tests basic connectivity to Opensteer cloud API
 */

import { OpensteerCloudClient } from "./packages/opensteer/dist/index.js";

async function testCloudConnection() {
  console.log("Testing Cloud API Connection...\n");

  const configs = [
    {
      name: "api.opensteer.com",
      apiKey: "osk_nUQPYQ_4PG40bs6XzA8kAoFPkGkpbnxJqNg7PUT",
      baseUrl: "https://api.opensteer.com",
    },
    {
      name: "api.opensteer.dev",
      apiKey: "osk_nUQPYQ_4PG40bs6XzA8kAoFPkGkpbnxJqNg7PUT",
      baseUrl: "https://api.opensteer.dev",
    },
  ];

  for (const config of configs) {
    console.log(`Testing: ${config.name}`);
    console.log(`  Base URL: ${config.baseUrl}`);
    console.log(`  API Key: ${config.apiKey.substring(0, 15)}...`);

    const client = new OpensteerCloudClient(config);

    try {
      // Try to list sessions (simple GET request)
      console.log(`  Attempting: GET /v1/sessions`);
      const sessions = await client.listSessions();
      console.log(`  ✅ Success! Response:`, JSON.stringify(sessions, null, 2));
    } catch (error) {
      console.log(`  ❌ Failed: ${error.message}`);
      if (error.cause) {
        console.log(`     Cause: ${error.cause.message || error.cause}`);
      }
    }

    console.log("");
  }
}

testCloudConnection().catch(console.error);
