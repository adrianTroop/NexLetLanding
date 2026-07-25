import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

const IDLE_NOTE = 'No public sign-up. Every account is reviewed.'

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
      const waitlist = JSON.parse(localStorage.getItem('nexlet_waitlist') || '[]')
      waitlist.push({ email: clean, role, timestamp: new Date().toISOString() })
      localStorage.setItem('nexlet_waitlist', JSON.stringify(waitlist))
      setStatus('success')
      setNote('Request received — we will be in touch.')
      return
    }

    const { error } = await supabase.from('waitlist').insert([{ email: clean, role }])

    if (error) {
      setStatus('error')
      setNote(error.code === '23505' // pg unique_violation — was sniffing the message string
        ? 'This email is already on the list.'
        : 'Something went wrong. Please try again.')
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
            <option value="agent">Agent</option>
            <option value="owner">Owner</option>
            <option value="vendor">Vendor</option>
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
