#!/usr/bin/env node
/**
 * List Browser Profiles to find the Bluebook profile ID
 */

async function listBrowserProfiles() {
  console.log("Listing Browser Profiles...\n");

  const apiKey = readRequiredEnv("OPENSTEER_API_KEY");
  const baseUrl = "https://api.opensteer.com";

  try {
    const response = await fetch(`${baseUrl}/v1/browser-profiles`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json; charset=utf-8",
      },
    });

    if (!response.ok) {
      console.log(`❌ Failed with status ${response.status}`);
      const text = await response.text();
      console.log("Response:", text);
      return;
    }

    const data = await response.json();
    console.log("✅ Browser Profiles:\n");
    console.log(JSON.stringify(data, null, 2));

    // Extract just the names and IDs
    if (data.profiles && Array.isArray(data.profiles)) {
      console.log("\n\nSummary:");
      data.profiles.forEach((profile, i) => {
        console.log(
          `${i + 1}. Name: "${profile.name}" | ID: ${profile.profileId} | Status: ${profile.status}`,
        );
      });

      const bluebookProfiles = data.profiles.filter((p) => p.name.toLowerCase().includes("blue"));

      if (bluebookProfiles.length > 0) {
        console.log("\n\n🎯 Found Bluebook-related profiles:");
        bluebookProfiles.forEach((profile) => {
          console.log(`   Name: "${profile.name}"`);
          console.log(`   ID: ${profile.profileId}`);
          console.log(`   Status: ${profile.status}`);
          console.log(`   Active Session: ${profile.activeSessionId || "N/A"}`);
          console.log("");
        });
      }
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to run this cloud test.`);
  }
  return value;
}

listBrowserProfiles().catch(console.error);
