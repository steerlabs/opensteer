# Selectors

Selectors are stored as descriptors under `.oversteer/selectors/<namespace>`.

Each descriptor stores a DOM path with stable attributes and optional XPath.
On re-run, Oversteer generates multiple candidate selectors and attempts them
in priority order for robust replay.
