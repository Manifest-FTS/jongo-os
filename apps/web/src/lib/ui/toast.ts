"use client";

import { toast } from "react-hot-toast";

export function showSuccessToast(message: string): void {
  toast.success(message);
}

export function showErrorToast(message: string): void {
  toast.error(message);
}
