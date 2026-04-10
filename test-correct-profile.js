#!/usr/bin/env node
/**
 * Test with correct browser profile ID: bp_mns6y1w9_71eekrds
 */

async function testWithCorrectProfileId() {
  console.log("Testing with Correct Browser Profile ID\n");

  const apiKey = readRequiredEnv("OPENSTEER_API_KEY");
  const baseUrl = "https://api.opensteer.com";
  const profileId = "bp_mns6y1w9_71eekrds";

  console.log(`Profile ID: ${profileId}\n`);

  const testCases = [
    {
      name: "With browser profile",
      body: {
        browserProfile: {
          profileId: profileId,
          reuseIfActive: true,
        },
      },
    },
    {
      name: "With label and profile",
      body: {
        name: "test-bluebook-profile-session",
        browserProfile: {
          profileId: profileId,
          reuseIfActive: true,
        },
      },
    },
  ];

  for (const testCase of testCases) {
    console.log(`Test: ${testCase.name}`);
    console.log(`Body: ${JSON.stringify(testCase.body, null, 2)}`);

    try {
      const response = await fetch(`${baseUrl}/v1/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(testCase.body),
      });

      console.log(`  Status: ${response.status} ${response.statusText}`);

      const text = await response.text();

      if (response.ok) {
        console.log(`  ✅ Success!`);
        const data = JSON.parse(text);
        console.log(`  Session ID: ${data.sessionId}`);
        console.log(`  Status: ${data.status || "N/A"}`);
        if (data.baseUrl) console.log(`  Base URL: ${data.baseUrl}`);

        // Clean up - close the session
        console.log(`  Closing session...`);
        const closeResponse = await fetch(`${baseUrl}/v1/sessions/${data.sessionId}`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json; charset=utf-8",
          },
        });
        console.log(`  Session closed: ${closeResponse.status}`);
      } else {
        console.log(`  ❌ Failed`);
        console.log(`  Response: ${text}`);
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }

    console.log("");
  }
}

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to run this cloud test.`);
  }
  return value;
}

testWithCorrectProfileId().catch(console.error);
