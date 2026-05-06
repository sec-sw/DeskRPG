"use client";
//
// ChannelVoiceSettingsTab — owner-facing UI for the realtime voice subsystem.
// Pulls current state from /api/channels/[id]/voice on mount, lets the owner
// toggle enabled/access mode/proximity, and PATCHes the same route to save.
//
// Surfaces the "voice not configured" case explicitly so the owner can tell
// the difference between "I disabled it" and "the server has no LIVEKIT_*
// env vars set" — those need different remediation.

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

interface VoiceSettings {
  enabled: boolean;
  accessMode: "members" | "open";
  proximityEnabled: boolean;
  proximityRadius: number;
}

interface VoiceResponse {
  voice: VoiceSettings;
  livekitConfigured: boolean;
}

interface Props {
  channelId: string;
}

export default function ChannelVoiceSettingsTab({ channelId }: Props) {
  const t = useT();
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [livekitConfigured, setLivekitConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/channels/${channelId}/voice`, {
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as VoiceResponse;
        if (cancelled) return;
        setSettings(data.voice);
        setLivekitConfigured(data.livekitConfigured);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const persist = useCallback(
    async (patch: Partial<VoiceSettings>) => {
      if (!settings) return;
      const next = { ...settings, ...patch };
      setSettings(next); // optimistic
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/channels/${channelId}/voice`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data?.errorCode || `HTTP ${res.status}`);
          // Re-fetch on save failure so we don't leave stale optimistic state.
          const freshRes = await fetch(`/api/channels/${channelId}/voice`, {
            credentials: "same-origin",
          });
          if (freshRes.ok) {
            const fresh = (await freshRes.json()) as VoiceResponse;
            setSettings(fresh.voice);
          }
          return;
        }
        const data = (await res.json()) as { voice: VoiceSettings };
        setSettings(data.voice);
        setSavedAt(Date.now());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [channelId, settings],
  );

  if (loading) {
    return <p className="text-gray-400 text-sm py-4 text-center">{t("common.loading")}</p>;
  }
  if (!settings) {
    return (
      <p className="text-red-400 text-sm py-4 text-center">{error || t("voice.notConfigured")}</p>
    );
  }

  return (
    <div className="space-y-4">
      {!livekitConfigured && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-amber-300 text-sm font-semibold">{t("voice.serverNotConfigured")}</p>
          <p className="text-amber-200/80 text-xs mt-1">{t("voice.serverNotConfiguredHelp")}</p>
        </div>
      )}

      <ToggleRow
        label={t("voice.settingsEnabled")}
        helpText={t("voice.settingsEnabledHelp")}
        value={settings.enabled}
        disabled={saving || !livekitConfigured}
        onChange={(v) => persist({ enabled: v })}
      />

      <div>
        <label className="block text-sm font-semibold text-gray-300 mb-1">
          {t("voice.settingsAccessMode")}
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving || !settings.enabled}
            onClick={() => persist({ accessMode: "members" })}
            className={`px-3 py-1 rounded text-sm ${
              settings.accessMode === "members"
                ? "bg-indigo-600 text-white"
                : "bg-gray-700 text-gray-300"
            } disabled:opacity-50`}
          >
            {t("voice.accessMembers")}
          </button>
          <button
            type="button"
            disabled={saving || !settings.enabled}
            onClick={() => persist({ accessMode: "open" })}
            className={`px-3 py-1 rounded text-sm ${
              settings.accessMode === "open"
                ? "bg-indigo-600 text-white"
                : "bg-gray-700 text-gray-300"
            } disabled:opacity-50`}
          >
            {t("voice.accessOpen")}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          {settings.accessMode === "open"
            ? t("voice.accessOpenHelp")
            : t("voice.accessMembersHelp")}
        </p>
      </div>

      <ToggleRow
        label={t("voice.settingsProximity")}
        helpText={t("voice.settingsProximityHelp")}
        value={settings.proximityEnabled}
        disabled={saving || !settings.enabled}
        onChange={(v) => persist({ proximityEnabled: v })}
      />

      {settings.proximityEnabled && (
        <div>
          <label className="block text-sm font-semibold text-gray-300 mb-1">
            {t("voice.settingsProximityRadius")}{" "}
            <span className="text-gray-500 font-normal">({settings.proximityRadius})</span>
          </label>
          <input
            type="range"
            min={1}
            max={30}
            step={1}
            value={settings.proximityRadius}
            disabled={saving}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSettings((prev) => (prev ? { ...prev, proximityRadius: v } : prev));
            }}
            onMouseUp={(e) => {
              persist({ proximityRadius: Number((e.target as HTMLInputElement).value) });
            }}
            onTouchEnd={(e) => {
              persist({ proximityRadius: Number((e.target as HTMLInputElement).value) });
            }}
            className="w-full"
          />
          <p className="text-xs text-gray-400 mt-1">{t("voice.settingsProximityRadiusHelp")}</p>
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}
      {savedAt && Date.now() - savedAt < 2000 && (
        <p className="text-green-400 text-xs">{t("settings.saved")}</p>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  helpText,
  value,
  disabled,
  onChange,
}: {
  label: string;
  helpText?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-200">{label}</p>
        {helpText && <p className="text-xs text-gray-400 mt-0.5">{helpText}</p>}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!value)}
        aria-pressed={value}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${
          value ? "bg-indigo-600" : "bg-gray-700"
        } disabled:opacity-50`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
            value ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}
