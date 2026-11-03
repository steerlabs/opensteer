# Write a discoverable skill

Create `skills/<name>/SKILL.md` inside the Workspace. Use a lowercase hyphenated name matching its
directory; the `opensteer-` prefix is reserved for bundled skills. Start with YAML frontmatter:

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
from `SKILL.md` with when and how to use them. A Workspace skill shadows an integration skill of
the same name; it cannot replace the reserved Opensteer skills. The Runner discovers Workspace
skills at the start of a Run. Read a newly written skill directly to use it in the current Run.
