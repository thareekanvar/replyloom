import { useState } from "react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Button } from "@workspace/ui/components/button"
import { SmileIcon } from "lucide-react"
import { EMOJI_CATEGORIES } from "./emoji-data"

export function EmojiPicker({
  onPick,
  disabled,
}: {
  onPick: (emoji: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState(0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="mb-0.5 shrink-0 text-muted-foreground"
            disabled={disabled}
            aria-label="Emoji"
          />
        }
      >
        <SmileIcon />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5">
          {EMOJI_CATEGORIES.map((cat, i) => (
            <button
              key={cat.label}
              type="button"
              title={cat.label}
              onClick={() => setActiveCategory(i)}
              className={`shrink-0 rounded-md px-2 py-1 text-lg leading-none hover:bg-accent ${
                activeCategory === i ? "bg-accent" : ""
              }`}
            >
              {cat.emojis[0]}
            </button>
          ))}
        </div>
        <div className="grid max-h-64 grid-cols-8 gap-0.5 overflow-y-auto p-2">
          {EMOJI_CATEGORIES[activeCategory].emojis.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              type="button"
              onClick={() => {
                onPick(emoji)
                setOpen(false)
              }}
              className="flex size-8 items-center justify-center rounded-md text-xl leading-none hover:bg-accent"
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
