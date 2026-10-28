import { submit } from "./api";

export const submitOrder = () => (submit().ok ? "accepted" : "error");
