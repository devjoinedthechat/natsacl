# Security

`natsacl` generates broker permissions. A defect that makes it emit a grant the code does not need, or that lets a subject it cannot resolve pass silently, is a security issue.

Report such issues privately through [GitHub security advisories](https://github.com/devjoinedthechat/natsacl/security/advisories/new) rather than a public issue. Include the shape of the code that triggers it (a minimal fixture is ideal) and the output you expected.

What is in scope: over-grants, silent widening, a diagnostic that should be an error and is not, an output format the server interprets differently from what the model says. What is not: the permissions your own code implies — the compiler's job is to reflect the code faithfully, and `policy.forbid` is the place to constrain it.
