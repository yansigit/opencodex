# OrcaRouter provider maintenance record

Maintenance owner: [@yansigit](https://github.com/yansigit), accepted by the fork owner on 2026-09-07.
Primary-source review date: 2026-09-07.

- [API introduction](https://docs.orcarouter.ai/introduction): documents the OpenAI-compatible endpoint `https://api.orcarouter.ai/v1`.
- [Model discovery](https://docs.orcarouter.ai/getting-started/models): documents bearer-authenticated `GET /v1/models`. This record verifies the documented contract, not a live authenticated request.
- [Browser authorization](https://docs.orcarouter.ai/getting-started/sign-in-with-orcarouter): documents state and S256 PKCE for an API-key grant. The integration uses the bounded OAuth transport and refuses redirects; no account login was performed for this review.
- [Terms of service](https://www.orcarouter.ai/terms.html): sections 2–3 identify CONTINUUM AI PTE. LTD. (Singapore) and describe the gateway's upstream-provider routing service. Sections 5, 6 and 8 describe provider-policy obligations and processing requests on the user's behalf. Section 9 grants access to that service subject to its terms and fees.

The terms provide public evidence for customer use of the routing service. They are not independent verification of private resale or upstream-provider contracts; no such contracts were inspected. This record must not be cited as proof of partnerships or upstream endorsement.

Upstream integration source: `f7f890ff72a5ccccadb5a935c1ea106922562cd2`, now also verified as the remote `v2.47.0` tag on 2026-09-07.
