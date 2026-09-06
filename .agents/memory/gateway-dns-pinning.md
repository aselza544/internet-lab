---
name: Pinned DNS lookup callbacks
description: Node HTTP custom lookup callbacks may be invoked with all=true.
---

When an outbound Node HTTP(S) request pins a previously validated DNS address, the custom lookup callback must honor `options.all`: return an array of `{ address, family }` objects when it is true, and a single address/family pair otherwise.

**Why:** Node's request internals can ask for all lookup results even when the caller wants one pinned address; returning the scalar form in that case produces `ERR_INVALID_IP_ADDRESS`.

**How to apply:** Keep the pinned address selected from a validated DNS result, and adapt the callback response shape to the options passed by Node.