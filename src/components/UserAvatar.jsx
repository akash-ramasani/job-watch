import React from "react";
import { diceBearUrl, getCachedAvatarUrl } from "../utils/avatar.js";

const SIZE_CLASSES = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-12 w-12",
  xl: "h-full w-full",
};

/**
 * Renders the user's avatar. Resolution order:
 *   1. avatarUrl prop (e.g. from Firestore userMeta)
 *   2. localStorage cache for this uid
 *   3. Deterministic DiceBear URL fallback
 * The chosen URL is used directly in <img src>, so the browser HTTP cache
 * handles repeat loads. Firebase Storage uploads set immutable cache headers.
 */
export default function UserAvatar({
  uid,
  avatarUrl,
  name,
  email,
  size = "sm",
  className = "",
  alt,
}) {
  const seed = uid || email || name || "anon";
  const src = avatarUrl || getCachedAvatarUrl(uid) || diceBearUrl(seed);
  const sizeCls = SIZE_CLASSES[size] || SIZE_CLASSES.sm;
  const roundCls = className.includes("rounded-") ? "" : "rounded-full";

  return (
    <img
      src={src}
      alt={alt || name || email || "User avatar"}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={(e) => {
        if (e.currentTarget.src !== diceBearUrl(seed)) {
          e.currentTarget.src = diceBearUrl(seed);
        }
      }}
      className={`${sizeCls} ${roundCls} shrink-0 object-cover bg-gray-100 ${className}`}
    />
  );
}
