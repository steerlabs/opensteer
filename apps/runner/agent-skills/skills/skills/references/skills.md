# Write a discoverable skill

Create `skills/<name>/SKILL.md` inside Agent home. Use a lowercase hyphenated name matching its
directory. Loose skills use bare names; plugin skills use `plugin:skill`, including `opensteer:browser`. The `opensteer` plugin namespace is reserved. Start with YAML frontmatter:

```markdown
---
name: compare-offers
description: Compare current offers against the saved requirements, including total cost and availability.
---

# Compare offers

Read the saved requirements and previous observations. Collect current evidence, compare total
cost on the same basis, and record source links and observation times. Mark missing information
explicitly. Report changes that satisfy the user's criteria.
```

Put detailed references and executable helpers alongside the skill when useful, and link them
from `SKILL.md` with when and how to use them. Two plugins may export the same local name under their namespaces; the Runner loads each canonical source once. Owner-enabled plugin skills and Agent home skills are discovered at Run start. Resource grants do not enable skills. Read a newly written skill directly to use it in the current Run.
