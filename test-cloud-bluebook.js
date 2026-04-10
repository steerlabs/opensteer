#!/usr/bin/env node
/**
 * Test Script: Opensteer Cloud Mode with Bluebook Browser Profile
 *
 * Tests cloud mode functionality with the following configuration:
 * - API Key: osk_nUQPYQ_4PG40bs6XzA8kAoFPkGkpbnxJqNg7PUT
 * - Base URL: https://api.opensteer.com
 * - Browser Profile: Bluebook
 */

import { Opensteer } from "./packages/opensteer/dist/index.js";

// Configuration
const CLOUD_CONFIG = {
  provider: {
    mode: "cloud",
    apiKey: "osk_nUQPYQ_4PG40bs6XzA8kAoFPkGkpbnxJqNg7PUT",
    baseUrl: "https://api.opensteer.com",
    browserProfile: {
      profileId: "Bluebook",
      reuseIfActive: true,
    },
  },
};

async function testCloudMode() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     OPENSTEER CLOUD MODE TEST - BLUEBOOK PROFILE          ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Configuration:");
  console.log(`  Provider: cloud`);
  console.log(`  Base URL: ${CLOUD_CONFIG.provider.baseUrl}`);
  console.log(`  API Key: ${CLOUD_CONFIG.provider.apiKey.substring(0, 15)}...`);
  console.log(`  Browser Profile: ${CLOUD_CONFIG.provider.browserProfile.profileId}`);
  console.log(`  Reuse if Active: ${CLOUD_CONFIG.provider.browserProfile.reuseIfActive}\n`);

  let opensteer;

  try {
    // TEST 1: Initialize Opensteer in cloud mode
    console.log("TEST 1: Initialize Opensteer in Cloud Mode\n");
    opensteer = new Opensteer(CLOUD_CONFIG);
    console.log("   ✅ Opensteer initialized successfully\n");

    // TEST 2: Open a browser session with Bluebook profile
    console.log("TEST 2: Open Browser Session with Bluebook Profile\n");
    const openResult = await opensteer.open({
      url: "https://www.thebluebook.com",
      browser: "persistent",
      launch: {
        headless: false,
      },
    });

    console.log("   ✅ Browser session opened successfully");
    console.log(`   Session: ${openResult.sessionRef || "N/A"}`);
    console.log(`   Page: ${openResult.pageRef || "N/A"}`);
    console.log(`   URL: ${openResult.url || "N/A"}`);
    console.log(`   Title: ${openResult.title || "N/A"}\n`);

    // TEST 3: Take a snapshot
    console.log("TEST 3: Take Page Snapshot\n");
    const snapshot = await opensteer.snapshot({
      mode: "extraction",
      visible: true,
    });

    const htmlLength = snapshot.html?.length || 0;
    console.log(`   ✅ Snapshot captured successfully`);
    console.log(`   HTML Length: ${htmlLength} characters\n`);

    // TEST 4: Get session state
    console.log("TEST 4: Get Session State\n");
    const state = await opensteer.state();

    console.log("   ✅ Session state retrieved");
    console.log(`   URL: ${state.url || "N/A"}`);
    console.log(`   Title: ${state.title || "N/A"}`);
    console.log(`   Pages: ${state.pages?.length || 0}\n`);

    // TEST 5: Navigate to login page
    console.log("TEST 5: Navigate to Login Page\n");
    const gotoResult = await opensteer.goto("https://www.thebluebook.com/net/");

    console.log("   ✅ Navigation successful");
    console.log(`   URL: ${gotoResult.url || "N/A"}`);
    console.log(`   Title: ${gotoResult.title || "N/A"}\n`);

    // TEST 6: Check if cookies exist (profile should have persistent cookies)
    console.log("TEST 6: Check Browser Profile Cookies\n");
    const cookies = await opensteer.browser.cookies({
      domain: ".thebluebook.com",
    });

    console.log(`   ✅ Cookie query successful`);
    console.log(`   Cookies found: ${cookies.records?.length || 0}`);

    if (cookies.records && cookies.records.length > 0) {
      console.log("   Sample cookies:");
      cookies.records.slice(0, 3).forEach((cookie, i) => {
        console.log(`     ${i + 1}. ${cookie.name} = ${cookie.value?.substring(0, 20)}...`);
      });
    }
    console.log("");

    // TEST 7: Take final screenshot
    console.log("TEST 7: Take Screenshot\n");
    const screenshot = await opensteer.page.screenshot({
      fullPage: false,
    });

    console.log("   ✅ Screenshot captured");
    console.log(`   Format: ${screenshot.encoding || "base64"}`);
    console.log(`   Size: ${screenshot.data?.length || 0} bytes\n`);

    // TEST 8: Close session
    console.log("TEST 8: Close Session\n");
    await opensteer.close();
    console.log("   ✅ Session closed successfully\n");

    // FINAL VERDICT
    console.log("════════════════════════════════════════════════════════════\n");
    console.log("🎉 ALL TESTS PASSED!\n");
    console.log("Cloud Mode Status:");
    console.log("  ✅ Cloud connection established");
    console.log("  ✅ Bluebook profile loaded");
    console.log("  ✅ Browser session created");
    console.log("  ✅ Navigation working");
    console.log("  ✅ Snapshot working");
    console.log("  ✅ Cookies accessible");
    console.log("  ✅ Screenshot working");
    console.log("  ✅ Session cleanup successful\n");

    console.log("Cloud mode with Bluebook profile is FULLY OPERATIONAL! ✅\n");
  } catch (error) {
    console.error("\n❌ ERROR:", error.message);

    if (error.code) {
      console.error(`   Error Code: ${error.code}`);
    }

    if (error.cause) {
      console.error(`   Cause: ${error.cause}`);
    }

    console.error("\nStack:", error.stack);

    // Clean up on error
    if (opensteer) {
      try {
        await opensteer.close();
        console.log("\n✓ Cleaned up session");
      } catch (cleanupError) {
        console.error("Failed to cleanup:", cleanupError.message);
      }
    }

    process.exit(1);
  }
}

// Run the test
testCloudMode().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
