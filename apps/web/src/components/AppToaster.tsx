"use client";

import { Toaster } from "react-hot-toast";

export default function AppToaster() {
  return (
    <Toaster
      position="bottom-left"
      containerStyle={{
        bottom: "150px"
      }}
      toastOptions={{
        duration: 2200,
        style: {
          borderRadius: "10px",
          border: "1px solid rgba(5, 31, 21, 0.2)",
          background: "var(--privacy-green)",
          color: "#ffffff",
          boxShadow: "0 12px 28px rgba(16, 64, 48, 0.24)",
          fontSize: "0.9rem"
        },
        success: {
          iconTheme: {
            primary: "#ffffff",
            secondary: "var(--privacy-green)"
          }
        },
        error: {
          iconTheme: {
            primary: "#ffd6d6",
            secondary: "#8f1d1d"
          }
        }
      }}
    />
  );
}
