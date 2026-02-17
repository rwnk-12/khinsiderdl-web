import React from 'react';
import type { AudioQualityPreference } from '../lib/app-types';

const QUALITY_OPTIONS: ReadonlyArray<{ value: AudioQualityPreference; label: string }> = [
    { value: 'best', label: 'Best Available' },
    { value: 'flac', label: 'FLAC Only' },
    { value: 'mp3', label: 'MP3' },
    { value: 'm4a', label: 'M4A / AAC' },
];

export const SettingsView = ({
    currentQ,
    onSetQ,
}: {
    currentQ: AudioQualityPreference;
    onSetQ: (q: AudioQualityPreference) => void;
}) => {
    const activeOption = QUALITY_OPTIONS.find((opt) => opt.value === currentQ) || QUALITY_OPTIONS[0];

    return (
        <div className="settings-panel">
            <section className="settings-surface settings-summary" aria-label="Current download preference">
                <span className="f-ui settings-summary-kicker">Current Default</span>
                <h2 className="settings-summary-title">{activeOption.label}</h2>
            </section>

            <section className="settings-surface setting-group" aria-label="Download quality options">
                <div className="setting-group-head">
                    <h3 className="setting-group-title">Download Quality</h3>
                </div>
                <div className="setting-options">
                    {QUALITY_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => onSetQ(opt.value)}
                            className={`setting-option ${currentQ === opt.value ? 'active' : ''}`}
                            aria-pressed={currentQ === opt.value}
                        >
                            <div className="setting-label">{opt.label}</div>
                        </button>
                    ))}
                </div>
            </section>
        </div>
    );
};

