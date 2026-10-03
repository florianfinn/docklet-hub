/**
 * The image that stands in an arm's archive, pinned to a SemVer tag.
 *
 * ⚠️ Since #279 the repository is `docklet-hub-agent`: one tag
 * `v<semver>` of this repo builds hub and agent together
 * (`.github/workflows/release.yml`), both with the same version. No digest
 * stands behind the tag yet — it only exists once the workflow has run for the
 * first time, and is added afterwards, here and in `docker-compose.yml`.
 *
 * ⚠️ Why a constant and not a value from the environment: the hub container is
 * not handed `DOCKER_AGENT_IMAGE`, and the line in `.env.example` is commented
 * out on purpose (it carries an example value nobody should roll out). So that
 * the two places do not drift apart anyway, `enrollment.test.ts` compares this
 * constant against the default in `docker-compose.yml`.
 */
export const ARM_AGENT_IMAGE = "ghcr.io/florianfinn/docklet-hub-agent:v0.32.0";
