#!/usr/bin/env node
/**
 * Direct POST test to /v1/sessions
 */

async function testDirectPost() {
  console.log('Testing Direct POST to /v1/sessions\n');
  
  const apiKey = 'osk_nUQPYQ_4PG40bs6XzA8kAoFPkGkpbnxJqNg7PUT';
  const baseUrl = 'https://api.opensteer.com';
  
  const testCases = [
    {
      name: 'Minimal body',
      body: {}
    },
    {
      name: 'With Bluebook profile',
      body: {
        browserProfile: {
          profileId: 'Bluebook',
          reuseIfActive: true
        }
      }
    },
    {
      name: 'With label',
      body: {
        name: 'test-session'
      }
    },
    {
      name: 'With label and profile',
      body: {
        name: 'test-bluebook-session',
        browserProfile: {
          profileId: 'Bluebook',
          reuseIfActive: true
        }
      }
    }
  ];
  
  for (const testCase of testCases) {
    console.log(`Test: ${testCase.name}`);
    console.log(`Body: ${JSON.stringify(testCase.body, null, 2)}`);
    
    try {
      const response = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(testCase.body)
      });
      
      console.log(`  Status: ${response.status} ${response.statusText}`);
      
      const text = await response.text();
      
      if (response.ok) {
        console.log(`  ✅ Success!`);
        const data = JSON.parse(text);
        console.log(`  Session ID: ${data.sessionId}`);
        console.log(`  Status: ${data.status}`);
      } else {
        console.log(`  ❌ Failed`);
        console.log(`  Response: ${text.substring(0, 500)}`);
      }
      
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    
    console.log('');
  }
}

testDirectPost().catch(console.error);
