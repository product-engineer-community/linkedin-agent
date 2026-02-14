// SDK — agent-friendly functions for programmatic use
export { postToLinkedIn, editLinkedInPost, deleteLinkedInPost } from "./poster";
export type { PostOptions, EditOptions, PostResult } from "./poster";
export { loadCredentials, getValidCredentials, authenticate } from "./auth";
export type { Credentials } from "./auth";
