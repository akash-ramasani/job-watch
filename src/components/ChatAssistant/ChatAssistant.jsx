import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { db, auth } from '../../firebase';
import { getIdToken } from 'firebase/auth';
import { collection, query, orderBy, limit, addDoc, serverTimestamp, getDocs, writeBatch } from 'firebase/firestore';
import { track } from '../../lib/analytics.js';

const ASSISTANT_URL = 'https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/askAssistant';
const HISTORY_LOAD = 60;   // most recent saved messages shown when the chat opens
const HISTORY_SEND = 30;   // recent messages the assistant sees for context

const SUGGESTIONS = [
  "What came in today that fits me?",
  "Latest jobs in California in the past 24 hours",
  "Remote roles posted this week",
  "Which companies posted the most today?",
];

const greetingFor = (name) =>
  `Hi${name ? ` ${name}` : ''}! I'm JobWatch AI. Ask me about new jobs by place, time or company, your best matches, or anything about your search.`;

export default function ChatAssistant({ user, firstName = '' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([{ role: 'assistant', content: greetingFor(firstName) }]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasHistory, setHasHistory] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Load the most recent saved turns (newest first, then put back in order).
  useEffect(() => {
    if (!user?.uid) return;

    async function loadHistory() {
      try {
        const q = query(
          collection(db, "users", user.uid, "chatHistory"),
          orderBy("timestamp", "desc"),
          limit(HISTORY_LOAD)
        );
        const snapshot = await getDocs(q);
        const history = snapshot.docs
          .map(doc => ({ role: doc.data().role, content: doc.data().content }))
          .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .reverse();
        if (history.length > 0) {
          setMessages(history);
          setHasHistory(true);
        }
      } catch (error) {
        console.error("Error loading chat history:", error);
      }
    }

    loadHistory();
  }, [user?.uid]);

  useEffect(() => {
    if (!hasHistory) setMessages([{ role: 'assistant', content: greetingFor(firstName) }]);
  }, [firstName, hasHistory]);

  const scrollToBottom = (behavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        inputRef.current?.focus();
        scrollToBottom("auto");
      }, 100);
    }
  }, [isOpen]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const saveMessage = async (role, content) => {
    if (!user?.uid) return;
    try {
      await addDoc(collection(db, "users", user.uid, "chatHistory"), {
        role,
        content,
        timestamp: serverTimestamp()
      });
    } catch (error) {
      console.error("Error saving message:", error);
    }
  };

  const startNewChat = async () => {
    if (loading) return;
    setMessages([{ role: 'assistant', content: greetingFor(firstName) }]);
    setHasHistory(false);
    track('assistant_chat_cleared');
    if (!user?.uid) return;
    try {
      const snapshot = await getDocs(query(collection(db, "users", user.uid, "chatHistory"), limit(500)));
      const batch = writeBatch(db);
      snapshot.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    } catch (error) {
      console.error("Error clearing chat history:", error);
    }
  };

  const handleSend = async (e, presetText) => {
    if (e) e.preventDefault();
    const userContent = (presetText ?? inputValue).trim();
    if (!userContent || loading) return;

    const userMessage = { role: 'user', content: userContent };
    const newMessages = [...messages, userMessage];
    
    setMessages(newMessages);
    setHasHistory(true);
    setInputValue('');
    setLoading(true);

    // Save user message to Firestore
    saveMessage('user', userContent);

    const startedAt = Date.now();
    track('assistant_message_sent', { message_count: newMessages.length, char_count: userContent.length });

    try {
      const idToken = await getIdToken(auth.currentUser);
      const response = await fetch(ASSISTANT_URL, {
        method: 'POST',
        headers: {
          "X-Session-Token": localStorage.getItem("jw_session_token") || "",
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        // The greeting is local UI, not part of the conversation.
        body: JSON.stringify({ messages: newMessages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-HISTORY_SEND) }),
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        const assistantMsg = data.response;
        setMessages([...newMessages, assistantMsg]);
        // Save assistant response to Firestore
        saveMessage('assistant', assistantMsg.content);
        track('assistant_message_received', { duration_ms: Date.now() - startedAt });
      } else {
        const errorMsg = { role: 'assistant', content: `Error: ${data.error || 'Something went wrong.'}` };
        setMessages([...newMessages, errorMsg]);
        track('assistant_message_failed', { reason: data?.error?.slice(0, 80) || 'unknown' });
      }
    } catch (error) {
      const errorMsg = { role: 'assistant', content: 'Sorry, I failed to connect to the assistant.' };
      setMessages([...newMessages, errorMsg]);
      track('assistant_message_failed', { reason: error?.message?.slice(0, 80) || 'network' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="mb-4 w-80 sm:w-96 h-[600px] bg-white rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] border border-gray-100 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="p-4 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white flex justify-between items-center">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span className="font-bold text-sm uppercase tracking-widest">JobWatch AI</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={startNewChat}
                  disabled={loading}
                  title="Start a new conversation"
                  aria-label="Start a new conversation"
                  className="hover:bg-white/10 p-1 rounded-full transition-colors disabled:opacity-50"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
                <button 
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close"
                  className="hover:bg-white/10 p-1 rounded-full transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/50">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-3 rounded-2xl text-sm shadow-sm ${
                    msg.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-white text-gray-800 border border-gray-100 rounded-tl-none'
                  }`}>
                    <ReactMarkdown 
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({node, ...props}) => <p className="mb-2 last:mb-0" {...props} />,
                        ul: ({node, ...props}) => <ul className="list-disc ml-4 mb-2" {...props} />,
                        ol: ({node, ...props}) => <ol className="list-decimal ml-4 mb-2" {...props} />,
                        li: ({node, ...props}) => <li className="mb-1" {...props} />,
                        table: ({node, ...props}) => (
                          <div className="overflow-x-auto my-3 rounded-lg border border-gray-100">
                            <table className="min-w-full divide-y divide-gray-100 text-[11px]" {...props} />
                          </div>
                        ),
                        thead: ({node, ...props}) => <thead className="bg-gray-50" {...props} />,
                        th: ({node, ...props}) => <th className="px-2 py-1.5 text-left font-black uppercase tracking-widest text-gray-400" {...props} />,
                        td: ({node, ...props}) => <td className="px-2 py-1.5 border-t border-gray-50" {...props} />,
                        blockquote: ({node, ...props}) => <blockquote className="border-l-2 border-indigo-200 pl-3 italic text-gray-500 my-2" {...props} />,
                        strong: ({node, ...props}) => <strong className={msg.role === 'user' ? 'font-bold' : 'font-bold text-indigo-700'} {...props} />,
                        a: ({node, ...props}) => <a className={msg.role === 'user' ? 'underline' : 'text-indigo-600 underline hover:text-indigo-800'} target="_blank" rel="noopener noreferrer" {...props} />,
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
              {!loading && !hasHistory && messages.length === 1 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {SUGGESTIONS.map(text => (
                    <button
                      key={text}
                      type="button"
                      onClick={() => handleSend(null, text)}
                      className="text-xs px-3 py-1.5 rounded-full bg-white border border-indigo-100 text-indigo-700 hover:bg-indigo-50 transition-colors text-left"
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-white p-4 rounded-2xl rounded-tl-none border border-gray-100 flex gap-1 items-center shadow-sm">
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSend} className="p-4 bg-white border-t border-gray-100 flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Ask me anything..."
                className="flex-1 bg-gray-50 border-none rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
              />
              <button
                type="submit"
                disabled={loading || !inputValue.trim()}
                className="bg-indigo-600 text-white p-2 rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className="w-14 h-14 bg-indigo-600 rounded-full shadow-lg flex items-center justify-center text-white hover:bg-indigo-700 transition-colors"
      >
        {isOpen ? (
          <svg className="w-6 h-6 rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        )}
      </motion.button>
    </div>
  );
}
