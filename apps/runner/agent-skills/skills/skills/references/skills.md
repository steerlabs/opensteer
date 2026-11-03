# Write a discoverable skill

Create `skills/<name>/SKILL.md` inside the Workspace. Use a lowercase hyphenated name matching its
directory. Loose skills use bare names; plugin skills use `plugin:skill`, including `opensteer:browser`. The `opensteer` plugin namespace is reserved. Start with YAML frontmatter:

```markdown
---
name: compare-offers
description: Compare current offers against this Workspace's saved requirements, including total cost and availability.
---

# Compare offers

Read the saved requirements and previous observations. Collect current evidence, compare total
cost on the same basis, and record source links and observation times. Mark missing information
explicitly. Report changes that satisfy the user's criteria.
```

Put detailed references and executable helpers alongside the skill when useful, and link them
from `SKILL.md` with when and how to use them. Duplicate full names are refused; two plugins can export the same local name. Activation makes plugin skills visible; resource grants do not. The Runner discovers Workspace
skills at the start of a Run. Read a newly written skill directly to use it in the current Run.
