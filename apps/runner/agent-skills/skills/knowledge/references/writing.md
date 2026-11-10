# Writing facts

```sql
INSERT INTO facts (topic, thing, property, value, seen_fact_id)
VALUES ($1, 'trip/kyoto', 'hotel', '"Hotel C"', 41)
```

with `mode: "write"`. `value` is JSON: a string needs its quotes. Pass the `id` you read as `seen_fact_id` when replacing, or NULL for a fact you saw was absent. Add `onlyIfUnchanged: true` when the write is only right if nobody changed the fact since; a refusal then saved nothing, so read again and decide. Use opaque thing keys such as `customer/42`, not names or other personal details. Clear a value by appending JSON `null`.

Read the receipt. `unseenCount` above 0 means someone else wrote that fact after the version you read: read `fact_history` and tell the person if it matters. When a write may or may not have committed, read `facts` to check before writing again; never repeat it blindly.
