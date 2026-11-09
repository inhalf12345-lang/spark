import React, { useState } from 'react';
import {
  X,
  Coins,
  Check,
  Flame,
  Palette,
  CircleDot,
  Cpu,
  Sun,
  Terminal,
  Moon,
  Compass,
  Zap,
  Shield,
  Crown,
  ShoppingBag,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { ShopCategory, ShopItem, UserProfile } from '../types';
import { SHOP_ITEMS } from '../lib/storage';

interface ShopModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfile;
  onUpdateProfile: (updated: UserProfile) => void;
  onDeductCoins: (amount: number) => void;
}

export const ShopModal: React.FC<ShopModalProps> = ({
  isOpen,
  onClose,
  profile,
  onUpdateProfile,
  onDeductCoins,
}) => {
  const [activeCategory, setActiveCategory] = useState<ShopCategory>('frame');
  const [purchaseToast, setPurchaseToast] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentItems = SHOP_ITEMS.filter((item) => item.category === activeCategory);

  const isUnlocked = (itemId: string) => {
    return (
      profile.unlocked_items.includes(itemId) ||
      itemId === 'frame_pulsar' ||
      itemId === 'theme_cosmic' ||
      itemId === 'outfit_voyager'
    );
  };

  const isEquipped = (item: ShopItem) => {
    if (item.category === 'frame') return profile.equipped_frame === item.id;
    if (item.category === 'theme') return profile.equipped_theme === item.id;
    if (item.category === 'outfit') return profile.equipped_outfit === item.id;
    return false;
  };

  const handleEquip = (item: ShopItem) => {
    const updated: UserProfile = { ...profile };
    if (item.category === 'frame') updated.equipped_frame = item.id;
    if (item.category === 'theme') updated.equipped_theme = item.id;
    if (item.category === 'outfit') updated.equipped_outfit = item.id;

    onUpdateProfile(updated);
    setPurchaseToast(`Equipped ${item.name}!`);
    setTimeout(() => setPurchaseToast(null), 2500);
  };

  const handlePurchase = (item: ShopItem) => {
    if (profile.coins < item.price) {
      setPurchaseToast(`Need ${item.price - profile.coins} more coins! Chat to earn.`);
      setTimeout(() => setPurchaseToast(null), 3000);
      return;
    }

    try {
      confetti({
        particleCount: 40,
        spread: 70,
        origin: { y: 0.6, x: 0.5 },
        colors: ['#8B5CF6', '#A78BFA', '#38bdf8', '#ffd700'],
        disableForReducedMotion: true,
      });
    } catch {}

    const updatedUnlocked = Array.from(new Set([...profile.unlocked_items, item.id]));
    const updated: UserProfile = {
      ...profile,
      coins: Math.max(0, profile.coins - item.price),
      unlocked_items: updatedUnlocked,
    };

    if (item.category === 'frame') updated.equipped_frame = item.id;
    if (item.category === 'theme') updated.equipped_theme = item.id;
    if (item.category === 'outfit') updated.equipped_outfit = item.id;

    onUpdateProfile(updated);
    onDeductCoins(0);
    setPurchaseToast(`Unlocked & equipped ${item.name}!`);
    setTimeout(() => setPurchaseToast(null), 2500);
  };

  const renderIcon = (name: string) => {
    switch (name) {
      case 'CircleDot':
        return <CircleDot className="w-5 h-5 text-[#8B5CF6]" />;
      case 'Flame':
        return <Flame className="w-5 h-5 text-rose-500" />;
      case 'Cpu':
        return <Cpu className="w-5 h-5 text-teal-500" />;
      case 'Palette':
        return <Palette className="w-5 h-5 text-[#8B5CF6]" />;
      case 'Sun':
        return <Sun className="w-5 h-5 text-amber-500" />;
      case 'Terminal':
        return <Terminal className="w-5 h-5 text-emerald-500" />;
      case 'Moon':
        return <Moon className="w-5 h-5 text-purple-500" />;
      case 'Compass':
        return <Compass className="w-5 h-5 text-sky-500" />;
      case 'Zap':
        return <Zap className="w-5 h-5 text-[#8B5CF6]" />;
      case 'Shield':
        return <Shield className="w-5 h-5 text-amber-500" />;
      case 'Crown':
        return <Crown className="w-5 h-5 text-[#8B5CF6]" />;
      default:
        return <ShoppingBag className="w-5 h-5 text-[#8B5CF6]" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-[32px] bg-[#f8f7fc] border border-violet-100/90 shadow-2xl flex flex-col overflow-hidden text-slate-800 max-h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-violet-100/80 bg-white">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-violet-100/80 flex items-center justify-center text-[#8B5CF6]">
              <Palette className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-slate-900 tracking-tight">
                Theme &amp; Aura Customization
              </h2>
              <p className="text-[11px] text-slate-500">Personalize your frames, themes &amp; styles</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200/60 text-amber-700 text-xs font-bold">
              <Coins className="w-3.5 h-3.5 text-amber-500" />
              <span className="font-mono-numbers">{profile.coins.toLocaleString()}</span>
            </div>

            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-slate-100 hover:bg-violet-50 text-slate-500 hover:text-[#8B5CF6] flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Pill Tabs */}
        <div className="flex border-b border-violet-100/70 bg-white/80 px-4 py-2.5 gap-2 text-xs font-semibold">
          <button
            onClick={() => setActiveCategory('theme')}
            className={`py-1.5 px-3.5 rounded-full transition-all flex items-center gap-1.5 ${
              activeCategory === 'theme'
                ? 'bg-[#8B5CF6] text-white font-bold shadow-sm shadow-violet-500/25'
                : 'bg-white border border-violet-100 text-slate-500 hover:text-[#8B5CF6]'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            <span>Themes</span>
          </button>

          <button
            onClick={() => setActiveCategory('frame')}
            className={`py-1.5 px-3.5 rounded-full transition-all flex items-center gap-1.5 ${
              activeCategory === 'frame'
                ? 'bg-[#8B5CF6] text-white font-bold shadow-sm shadow-violet-500/25'
                : 'bg-white border border-violet-100 text-slate-500 hover:text-[#8B5CF6]'
            }`}
          >
            <CircleDot className="w-3.5 h-3.5" />
            <span>Frames</span>
          </button>

          <button
            onClick={() => setActiveCategory('outfit')}
            className={`py-1.5 px-3.5 rounded-full transition-all flex items-center gap-1.5 ${
              activeCategory === 'outfit'
                ? 'bg-[#8B5CF6] text-white font-bold shadow-sm shadow-violet-500/25'
                : 'bg-white border border-violet-100 text-slate-500 hover:text-[#8B5CF6]'
            }`}
          >
            <Crown className="w-3.5 h-3.5" />
            <span>Styles</span>
          </button>
        </div>

        {purchaseToast && (
          <div className="p-2.5 bg-violet-50 border-b border-violet-100 text-center text-xs font-bold text-[#7C3AED]">
            {purchaseToast}
          </div>
        )}

        {/* Catalog */}
        <div className="p-4 overflow-y-auto space-y-2.5 flex-1 max-h-[55vh]">
          {currentItems.map((item) => {
            const unlocked = isUnlocked(item.id);
            const equipped = isEquipped(item);

            return (
              <div
                key={item.id}
                className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between gap-3 ${
                  equipped
                    ? 'border-[#8B5CF6] bg-violet-50/70 shadow-[0_4px_14px_rgba(139,92,246,0.12)]'
                    : unlocked
                    ? 'border-violet-100/90 bg-white hover:border-violet-200 shadow-2xs'
                    : 'border-slate-200/70 bg-white/70 opacity-85'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-violet-50/90 border border-violet-100 flex items-center justify-center p-2 shrink-0">
                    {renderIcon(item.icon_name)}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <h4 className="font-display font-bold text-xs sm:text-sm text-slate-900">{item.name}</h4>
                      {item.badge && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-violet-100 text-[#7C3AED] font-bold">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">{item.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono-numbers text-xs font-bold text-amber-600">
                    {item.price === 0 ? 'FREE' : `${item.price} 🪙`}
                  </span>

                  {equipped ? (
                    <div className="px-3 py-1 rounded-full bg-[#8B5CF6] text-white text-xs font-bold flex items-center gap-1 shadow-2xs">
                      <Check className="w-3 h-3 stroke-[2.5]" />
                      <span>Active</span>
                    </div>
                  ) : unlocked ? (
                    <button
                      onClick={() => handleEquip(item)}
                      className="px-3.5 py-1.5 rounded-full bg-violet-100 hover:bg-violet-200/80 text-[#6D28D9] text-xs font-bold transition-all active:scale-95"
                    >
                      Apply
                    </button>
                  ) : (
                    <button
                      onClick={() => handlePurchase(item)}
                      className="px-3.5 py-1.5 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] text-white text-xs font-bold shadow-xs hover:opacity-95 active:scale-95 transition-all"
                    >
                      Unlock
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-3 bg-white border-t border-violet-100/80 text-[11px] text-slate-500 text-center">
          Earn coins by holding streaks, sending messages, and completing daily flow quests ✨
        </div>
      </div>
    </div>
  );
};
