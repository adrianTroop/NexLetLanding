import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

const IDLE_NOTE = 'No public sign-up. Every account is reviewed.'

// Values must satisfy request_access_desired_role_check: owner_admin | agent | owner | client.
// The page also invites vendors (chefs, drivers, security) but the product model has no such
// role yet — adding one needs that CHECK extended first.
const ROLES = [
  ['agent', 'Agent'],
  ['owner', 'Owner'],
] as const

export default function AccessForm() {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [note, setNote] = useState(IDLE_NOTE)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const clean = email.trim().toLowerCase()
    if (!clean || !role) return

    setStatus('loading')
    setNote(IDLE_NOTE)

    if (!supabase) {
      // ponytail: no backend configured — keep the request locally so nothing is lost
      const pending = JSON.parse(localStorage.getItem('nexlet_access_requests') || '[]')
      pending.push({ email: clean, desired_role: role, timestamp: new Date().toISOString() })
      localStorage.setItem('nexlet_access_requests', JSON.stringify(pending))
      setStatus('success')
      setNote('Request received — we will be in touch.')
      return
    }

    // status defaults to 'pending'; the anon RLS policy allows insert only, never select
    const { error } = await supabase.from('request_access').insert([{ email: clean, desired_role: role }])

    if (error) {
      setStatus('error')
      setNote('Something went wrong. Please try again.')
    } else {
      setStatus('success')
      setNote('Request received — we will be in touch.')
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {status !== 'success' && (
        <>
          <select value={role} onChange={(e) => setRole(e.target.value)} required aria-label="You are">
            <option value="" disabled>You are…</option>
            {ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input
            type="email"
            placeholder="Work email"
            required
            aria-label="Work email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" className="btn btn-p" disabled={status === 'loading'}>
            {status === 'loading' ? 'Sending' : 'Request'}
          </button>
        </>
      )}
      <div role="status" aria-live="polite" className={`note${status === 'success' ? ' ok' : status === 'error' ? ' err' : ''}`}>{note}</div>
    </form>
  )
}
