import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Panel } from "@workspace/ui/components/panel"

type Team = { id: string; name: string; description: string | null; members: { userId: string }[] }
type Member = { userId: string; name: string; email: string }

export function TeamsList({ teams, members, onCreate, onSaveMembers }: {
  teams: Team[]
  members: Member[]
  onCreate: (name: string) => void
  onSaveMembers: (teamId: string, userIds: string[]) => void
}) {
  const [name, setName] = useState("")
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(teams.map((team) => [team.id, team.members.map((member) => member.userId)]))
  )
  return <div className="flex flex-col gap-3">
    <div className="flex gap-2">
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="New team name" />
      <Button disabled={!name.trim()} onClick={() => { onCreate(name.trim()); setName("") }}>Create team</Button>
    </div>
    {teams.map((team) => {
      const ids = selected[team.id] ?? team.members.map((member) => member.userId)
      return <Panel key={team.id} className="flex flex-col gap-3 p-4">
        <div className="font-medium">{team.name}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {members.map((member) => <label key={member.userId} className="flex items-center gap-2 text-sm">
            <Checkbox checked={ids.includes(member.userId)} onCheckedChange={(checked) => setSelected((current) => ({ ...current, [team.id]: checked ? [...ids, member.userId] : ids.filter((id) => id !== member.userId) }))} />
            <span>{member.name}<span className="ml-1 text-xs text-muted-foreground">{member.email}</span></span>
          </label>)}
        </div>
        <Button size="sm" variant="outline" className="self-end" onClick={() => onSaveMembers(team.id, ids)}>Save members</Button>
      </Panel>
    })}
  </div>
}
