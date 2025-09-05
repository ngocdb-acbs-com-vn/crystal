import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { API } from '../../utils/api';
import { MarkdownPreview } from '../MarkdownPreview';
import { User, Bot, ChevronDown, ChevronRight, Eye, EyeOff, Settings2, Wrench, CheckCircle, XCircle, Clock, ArrowDown, Search, X, ChevronUp } from 'lucide-react';
import { parseTimestamp, formatDistanceToNow } from '../../utils/timestampUtils';
import { ThinkingPlaceholder, InlineWorkingIndicator } from './ThinkingPlaceholder';

// Copy all interfaces from RichOutputView
interface RawMessage {
  id?: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'result';
  role?: 'user' | 'assistant' | 'system';
  content?: string | any;
  message?: { content?: string | any; [key: string]: any };
  timestamp: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  parent_tool_use_id?: string;
  session_id?: string;
  [key: string]: any;
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  segments: MessageSegment[];
  metadata?: {
    agent?: string;
    model?: string;
    duration?: number;
    tokens?: number;
    cost?: number;
    systemSubtype?: string;
    sessionInfo?: any;
  };
}

type MessageSegment = 
  | { type: 'text'; content: string }
  | { type: 'tool_call'; tool: ToolCall }
  | { type: 'system_info'; info: any }
  | { type: 'thinking'; content: string };

interface ToolCall {
  id: string;
  name: string;
  input?: any;
  result?: ToolResult;
  status: 'pending' | 'success' | 'error';
  isSubAgent?: boolean;
  subAgentType?: string;
  parentToolId?: string;
  childToolCalls?: ToolCall[];
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

interface VirtuosoRichOutputViewProps {
  sessionId: string;
  sessionStatus?: string;
  settings?: RichOutputSettings;
}

export interface RichOutputSettings {
  showToolCalls: boolean;
  compactMode: boolean;
  collapseTools: boolean;
  showThinking: boolean;
  showSessionInit: boolean;
}

const defaultSettings: RichOutputSettings = {
  showToolCalls: true,
  compactMode: false,
  collapseTools: false,
  showThinking: true,
  showSessionInit: false,
};

export const VirtuosoRichOutputView = React.forwardRef<{ scrollToPrompt: (promptIndex: number) => void }, VirtuosoRichOutputViewProps>(
  ({ sessionId, sessionStatus, settings: propsSettings }, ref) => {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedMessages, setCollapsedMessages] = useState<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [showScrollButton, setShowScrollButton] = useState(false);
  
  // Search state
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{
    messageIndex: number;
    matches: Array<{
      segmentIndex: number;
      text: string;
      start: number;
      end: number;
    }>;
  }>>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  
  const localSettings = useMemo<RichOutputSettings>(() => {
    const saved = localStorage.getItem('richOutputSettings');
    return saved ? JSON.parse(saved) : defaultSettings;
  }, []);
  
  const settings = propsSettings || localSettings;
  
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    console.log('[ScrollDebug] scrollerRef callback received:', ref);
    if (ref && ref instanceof HTMLElement) {
      // Store the scroller element for later use
      (window as any).__virtuosoScroller = ref;
    }
  }, []);
  const isLoadingRef = useRef(false);
  const userMessageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const wasAtBottomRef = useRef(true);
  const loadMessagesRef = useRef<(() => Promise<void>) | null>(null);
  const isFirstLoadRef = useRef(true);
  const previousMessagesRef = useRef<ConversationMessage[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  // Save local settings to localStorage when they change
  useEffect(() => {
    if (!propsSettings) {
      localStorage.setItem('richOutputSettings', JSON.stringify(localSettings));
    }
  }, [localSettings, propsSettings]);
  
  // Expose scroll method via ref
  React.useImperativeHandle(ref, () => ({
    scrollToPrompt: (promptIndex: number) => {
      const filteredMsgs = settings.showSessionInit ? messages : 
        messages.filter(msg => !(msg.role === 'system' && msg.metadata?.systemSubtype === 'init'));
      
      // Find the actual index in filtered messages
      let userMessageCount = 0;
      let targetIndex = -1;
      
      for (let i = 0; i < filteredMsgs.length; i++) {
        if (filteredMsgs[i].role === 'user') {
          if (userMessageCount === promptIndex) {
            targetIndex = i;
            break;
          }
          userMessageCount++;
        }
      }
      
      if (targetIndex !== -1 && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({
          index: targetIndex,
          behavior: 'smooth',
          align: 'center'
        });
      }
    }
  }), [messages, settings.showSessionInit]);

  // Copy ALL the helper functions from RichOutputView
  const extractTextContent = (msg: RawMessage): string => {
    if (msg.message?.content && Array.isArray(msg.message.content)) {
      return msg.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('\n')
        .trim();
    }
    
    if (typeof msg.message?.content === 'string') {
      return msg.message.content.trim();
    }
    
    if (typeof msg.content === 'string') {
      return msg.content.trim();
    }
    
    if (msg.message?.parts && Array.isArray(msg.message.parts)) {
      return msg.message.parts
        .filter(part => part.text)
        .map(part => part.text)
        .join('\n')
        .trim();
    }
    
    return '';
  };

  const detectAgent = (msg: RawMessage): string => {
    if (msg.message?.model?.includes('claude')) return 'claude';
    if (msg.message?.model?.includes('gemini')) return 'gemini';
    if (msg.message?.model?.includes('gpt')) return 'gpt-4';
    
    if (msg.message?.content && Array.isArray(msg.message.content)) return 'claude';
    if (msg.message?.parts) return 'gemini';
    
    return 'unknown';
  };

  // Copy EXACT transformMessages function from RichOutputView
  const transformMessages = (rawMessages: RawMessage[]): ConversationMessage[] => {
    const transformed: ConversationMessage[] = [];
    
    // Performance optimization: Use traditional for loops instead of forEach for large arrays
    // First pass: Build tool result map and identify sub-agent relationships
    const toolResults = new Map<string, ToolResult>();
    const parentToolMap = new Map<string, string>(); // Map tool ID to parent tool ID
    
    // Identify all tool calls and their parent relationships first
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      // Check for parent_tool_use_id to identify sub-agent tool calls
      if (msg.parent_tool_use_id && msg.message?.content && Array.isArray(msg.message.content)) {
        const content = msg.message.content;
        for (let j = 0; j < content.length; j++) {
          const block = content[j];
          if (block.type === 'tool_use' && block.id) {
            parentToolMap.set(block.id, msg.parent_tool_use_id!);
          }
        }
      }
      
      if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
        const content = msg.message.content;
        for (let j = 0; j < content.length; j++) {
          const block = content[j];
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResults.set(block.tool_use_id, {
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              isError: block.is_error || false
            });
          }
        }
      }
    }
    
    // Second pass: Build all tool calls to prepare for hierarchy
    const allToolCalls = new Map<string, ToolCall>();
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      if (msg.type === 'assistant' && msg.message?.content && Array.isArray(msg.message.content)) {
        const content = msg.message.content;
        for (let j = 0; j < content.length; j++) {
          const block = content[j];
          if (block.type === 'tool_use') {
            const isTaskAgent = block.name === 'Task';
            const toolCall: ToolCall = {
              id: block.id,
              name: block.name,
              input: block.input,
              status: toolResults.has(block.id) ? 'success' : 'pending',
              result: toolResults.get(block.id),
              isSubAgent: isTaskAgent,
              subAgentType: isTaskAgent ? block.input?.subagent_type : undefined,
              parentToolId: parentToolMap.get(block.id),
              childToolCalls: []
            };
            allToolCalls.set(block.id, toolCall);
          }
        }
      }
    }
    
    // Build parent-child relationships
    const toolCallsArray = Array.from(allToolCalls.values());
    for (let i = 0; i < toolCallsArray.length; i++) {
      const toolCall = toolCallsArray[i];
      if (toolCall.parentToolId) {
        const parentTool = allToolCalls.get(toolCall.parentToolId);
        if (parentTool && parentTool.childToolCalls) {
          parentTool.childToolCalls.push(toolCall);
        }
      }
    }
    
    // Third pass: Build conversation messages
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      
      if (msg.type === 'user') {
        // Check if this is a tool result message
        let hasToolResult = false;
        let hasOnlyText = true;
        
        if (msg.message?.content && Array.isArray(msg.message.content)) {
          // Performance optimization: Use for loops instead of array methods
          const content = msg.message.content;
          for (let j = 0; j < content.length; j++) {
            if (content[j].type === 'tool_result') {
              hasToolResult = true;
              hasOnlyText = false;
              break;
            }
            if (content[j].type !== 'text') {
              hasOnlyText = false;
            }
          }
        }
        
        // Only show real user prompts (text-only messages without tool results)
        if (!hasToolResult && hasOnlyText) {
          const textContent = extractTextContent(msg);
          
          if (textContent) {
            const userMessage = {
              id: msg.id || `user-${i}-${msg.timestamp}`,
              role: 'user' as const,
              timestamp: msg.timestamp,
              segments: [{ type: 'text', content: textContent } as MessageSegment],
              metadata: { agent: detectAgent(msg) }
            };
            
            transformed.push(userMessage);
            
            // Removed: Commit summaries are now shown in the dedicated Commits panel
          }
        }
        // Skip tool result messages - they're attached to assistant messages
        
      } else if (msg.type === 'assistant') {
        const segments: MessageSegment[] = [];
        
        
        // Check for direct text field first (some messages come this way)
        if (msg.text && typeof msg.text === 'string') {
          segments.push({ type: 'text', content: msg.text.trim() });
        } else if (msg.message?.content && Array.isArray(msg.message.content)) {
          // Process each content block - use for loop for better performance
          const content = msg.message.content;
          for (let j = 0; j < content.length; j++) {
            const block = content[j];
            if (block.type === 'text' && block.text?.trim()) {
              segments.push({ type: 'text', content: block.text.trim() });
            } else if (block.type === 'thinking') {
              const thinkingContent = block.thinking || block.content || block.text;
              if (thinkingContent && typeof thinkingContent === 'string' && thinkingContent.trim()) {
                segments.push({ type: 'thinking', content: thinkingContent.trim() });
              }
            } else if (block.type === 'tool_use') {
              const toolCall = allToolCalls.get(block.id);
              // Only add top-level tools (those without parents)
              if (toolCall && !toolCall.parentToolId) {
                segments.push({ type: 'tool_call', tool: toolCall });
              }
            }
          }
        } else {
          // Fallback for other formats
          const textContent = extractTextContent(msg);
          if (textContent) {
            segments.push({ type: 'text', content: textContent });
          }
        }
        
        // Only add message if it has content
        if (segments.length > 0) {
          // Check if this is a synthetic error message
          const isSyntheticError = msg.message?.model === '<synthetic>' && 
            segments.some(seg => seg.type === 'text' && 
              (seg.content.includes('Prompt is too long') || 
               seg.content.includes('API Error') ||
               seg.content.includes('error')));
          
          transformed.push({
            id: msg.id || `assistant-${i}-${msg.timestamp}`,
            role: isSyntheticError ? 'system' : 'assistant',
            timestamp: msg.timestamp,
            segments,
            metadata: {
              agent: detectAgent(msg),
              model: msg.message?.model,
              duration: msg.message?.duration,
              tokens: msg.message?.usage ? 
                (msg.message.usage.input_tokens || 0) + (msg.message.usage.output_tokens || 0) : 
                undefined,
              cost: msg.message?.usage?.cost,
              systemSubtype: isSyntheticError ? 'error' : undefined
            }
          });
        }
        
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        // Include system init messages
        transformed.push({
          id: msg.id || `system-init-${i}-${msg.timestamp}`,
          role: 'system',
          timestamp: msg.timestamp,
          segments: [{ 
            type: 'system_info', 
            info: {
              cwd: msg.cwd,
              model: msg.model,
              tools: msg.tools,
              mcp_servers: msg.mcp_servers,
              permissionMode: msg.permissionMode,
              session_id: msg.session_id
            }
          }],
          metadata: {
            systemSubtype: 'init',
            sessionInfo: msg
          }
        });
        
      } else if (msg.type === 'system' && msg.subtype === 'context_compacted') {
        // Handle context compaction messages
        transformed.push({
          id: msg.id || `context-compacted-${i}-${msg.timestamp}`,
          role: 'system',
          timestamp: msg.timestamp,
          segments: [{ 
            type: 'text', 
            content: msg.summary || ''
          }, {
            type: 'system_info',
            info: {
              message: msg.message
            }
          }],
          metadata: {
            systemSubtype: 'context_compacted'
          }
        });
        
      } else if (msg.type === 'system' && msg.subtype === 'error') {
        // Handle error messages from session manager
        transformed.push({
          id: msg.id || `error-${i}-${msg.timestamp}`,
          role: 'system',
          timestamp: msg.timestamp,
          segments: [{ 
            type: 'system_info', 
            info: {
              error: msg.error,
              details: msg.details,
              message: msg.message
            }
          }],
          metadata: {
            systemSubtype: 'error'
          }
        });
        
      } else if (msg.type === 'system' && msg.subtype === 'git_operation') {
        // Handle git operation messages
        transformed.push({
          id: msg.id || `git-operation-${i}-${msg.timestamp}`,
          role: 'system',
          timestamp: msg.timestamp,
          segments: [{ 
            type: 'text', 
            content: msg.message || msg.raw_output || ''
          }],
          metadata: {
            systemSubtype: 'git_operation'
          }
        });
        
      } else if (msg.type === 'system' && msg.subtype === 'git_error') {
        // Handle git error messages
        transformed.push({
          id: msg.id || `git-error-${i}-${msg.timestamp}`,
          role: 'system',
          timestamp: msg.timestamp,
          segments: [{ 
            type: 'text', 
            content: msg.message || msg.raw_output || ''
          }],
          metadata: {
            systemSubtype: 'git_error'
          }
        });
        
      } else if (msg.type === 'result') {
        // Handle execution result messages - especially errors
        if (msg.is_error && msg.result) {
          transformed.push({
            id: msg.id || `error-${i}-${msg.timestamp}`,
            role: 'system',
            timestamp: msg.timestamp,
            segments: [{ 
              type: 'text', 
              content: `Error: ${msg.result}`
            }],
            metadata: {
              systemSubtype: 'error',
              duration: msg.duration_ms,
              cost: msg.total_cost_usd
            }
          });
        }
        // Skip non-error result messages
        continue;
      }
    }
    
    return transformed;
  };

  const loadMessages = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    
    try {
      setError(null);
      
      const [conversationResponse, outputResponse] = await Promise.all([
        API.sessions.getConversation(sessionId),
        API.sessions.getJsonMessages(sessionId)
      ]);
      
      const userPrompts: RawMessage[] = [];
      if (conversationResponse.success && Array.isArray(conversationResponse.data)) {
        conversationResponse.data.forEach((msg: any) => {
          if (msg.message_type === 'user') {
            userPrompts.push({
              type: 'user',
              message: {
                role: 'user',
                content: [{ type: 'text', text: msg.content }]
              },
              timestamp: msg.timestamp
            });
          }
        });
      }
      
      const allMessages = [...userPrompts];
      if (outputResponse.success && outputResponse.data && Array.isArray(outputResponse.data)) {
        allMessages.push(...outputResponse.data);
      }
      
      allMessages.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeA - timeB;
      });
      
      // Progressive transformation for better performance
      if (allMessages.length > 100 && isFirstLoadRef.current) {
        // Transform first 50 messages immediately for quick display
        console.time('Transform initial batch');
        const initialBatch = allMessages.slice(-50); // Get last 50 messages (most recent)
        const initialMessages = transformMessages(initialBatch);
        setMessages(initialMessages);
        setLoading(false);
        console.timeEnd('Transform initial batch');
        
        // Transform remaining messages in background after a short delay
        setTimeout(() => {
          console.time('Transform remaining messages');
          const remainingBatch = allMessages.slice(0, -50); // Get all except last 50
          const remainingMessages = transformMessages(remainingBatch);
          const fullMessages = [...remainingMessages, ...initialMessages];
          setMessages(fullMessages);
          previousMessagesRef.current = fullMessages;
          console.timeEnd('Transform remaining messages');
        }, 100);
        
        isFirstLoadRef.current = false;
      } else {
        // Small number of messages or not first load - transform all at once
        console.time('Transform messages');
        const conversationMessages = transformMessages(allMessages);
        console.timeEnd('Transform messages');
        
        // Smart update logic for appending new messages
        if (previousMessagesRef.current.length > 0 && conversationMessages.length > previousMessagesRef.current.length) {
          // Check if this is just appending new messages (no changes to existing)
          let isJustAppending = true;
          for (let i = 0; i < previousMessagesRef.current.length; i++) {
            if (previousMessagesRef.current[i].id !== conversationMessages[i].id) {
              isJustAppending = false;
              break;
            }
          }
          
          if (isJustAppending) {
            // Just append the new messages
            const newMessages = conversationMessages.slice(previousMessagesRef.current.length);
            setMessages(prev => [...prev, ...newMessages]);
          } else {
            // Full reload needed
            setMessages(conversationMessages);
          }
        } else {
          // Full reload
          setMessages(conversationMessages);
        }
        
        previousMessagesRef.current = conversationMessages;
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
      setError('Failed to load conversation history');
    } finally {
      setLoading(false);
      isLoadingRef.current = false;
    }
  }, [sessionId]);

  useEffect(() => {
    loadMessagesRef.current = loadMessages;
  }, [loadMessages]);

  useEffect(() => {
    let debounceTimer: NodeJS.Timeout;
    
    const handleOutputAvailable = (event: CustomEvent<{ sessionId: string }>) => {
      if (event.detail.sessionId === sessionId) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          loadMessagesRef.current?.();
        }, 500);
      }
    };

    window.addEventListener('session-output-available', handleOutputAvailable as any);
    
    return () => {
      clearTimeout(debounceTimer);
      window.removeEventListener('session-output-available', handleOutputAvailable as any);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    isFirstLoadRef.current = true;
    wasAtBottomRef.current = true; // Start at bottom for new session
    previousMessagesRef.current = []; // Reset previous messages on session change
    lastMessageIdRef.current = null; // Reset last message ID on session change
    setSearchQuery(''); // Clear search on session change
    setIsSearchOpen(false);
    setMessages([]); // Clear messages immediately to avoid showing old session
    loadMessages();
  }, [sessionId, loadMessages]);

  // Helper function to scroll to absolute bottom with debug logging
  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'smooth') => {
    if (!virtuosoRef.current) {
      console.log('[ScrollDebug] virtuosoRef.current is null');
      return;
    }
    
    const scroller = (window as any).__virtuosoScroller;
    console.log('[ScrollDebug] scrollToBottom called', {
      behavior,
      messagesLength: messages.length,
      lastMessageIndex: messages.length - 1,
      hasScroller: !!scroller
    });
    
    // Method 1: Try scrollToIndex with the last message
    virtuosoRef.current.scrollToIndex({
      index: messages.length - 1,
      align: 'end',
      behavior
    });
    
    // Method 2: After a delay, directly manipulate the scroller element
    setTimeout(() => {
      console.log('[ScrollDebug] Forcing scroll to absolute bottom');
      
      const scrollerElement = (window as any).__virtuosoScroller;
      if (scrollerElement && scrollerElement instanceof HTMLElement) {
        console.log('[ScrollDebug] Using stored scroller directly', {
          scrollTop: scrollerElement.scrollTop,
          scrollHeight: scrollerElement.scrollHeight,
          clientHeight: scrollerElement.clientHeight,
          gap: scrollerElement.scrollHeight - (scrollerElement.scrollTop + scrollerElement.clientHeight)
        });
        // Force scroll to absolute bottom
        scrollerElement.scrollTop = scrollerElement.scrollHeight + 1000; // Add extra to ensure we reach the bottom
      } else {
        console.log('[ScrollDebug] Scroller not available, using virtuoso scrollTo');
        // Fallback to Virtuoso's scrollTo
        virtuosoRef.current?.scrollTo({
          top: 999999999,
          behavior
        });
      }
    }, 150);
  }, [messages.length]);

  // Auto-scroll on session change
  useEffect(() => {
    if (!loading && sessionId && messages.length > 0 && virtuosoRef.current) {
      // Force scroll to absolute bottom when switching to a new session
      setTimeout(() => {
        scrollToBottom('auto'); // Use instant scroll for session change
        // Extra scroll after initial render to ensure we're at absolute bottom
        setTimeout(() => {
          scrollToBottom('auto');
        }, 200);
      }, 100);
    }
  }, [sessionId, loading, scrollToBottom]);

  // Auto-scroll for new messages (both user and assistant)
  useEffect(() => {
    if (virtuosoRef.current && !loading && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      const isNewMessage = lastMessage.id !== lastMessageIdRef.current;
      
      // Auto-scroll conditions:
      // 1. A new user message was sent (ALWAYS scroll for user messages)
      // 2. A new assistant message and we were at bottom
      // 3. First load of session
      const shouldAutoScroll = 
        (isNewMessage && lastMessage.role === 'user') ||
        (isNewMessage && lastMessage.role === 'assistant' && wasAtBottomRef.current) ||
        isFirstLoadRef.current;
      
      if (shouldAutoScroll && isNewMessage) {
        // For user messages, scroll immediately
        const delay = lastMessage.role === 'user' ? 50 : 150;
        setTimeout(() => {
          scrollToBottom('smooth');
          // Extra scroll to ensure we're at absolute bottom
          setTimeout(() => {
            scrollToBottom('smooth');
          }, 200);
        }, delay);
      }
      
      // Update the last message ID reference
      if (isNewMessage) {
        lastMessageIdRef.current = lastMessage.id;
      }
      
      // Clear first load flag
      if (isFirstLoadRef.current) {
        isFirstLoadRef.current = false;
      }
    }
  }, [messages, loading, scrollToBottom]);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Search functionality
  const performSearch = useCallback(async () => {
    if (!debouncedSearchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    
    const query = debouncedSearchQuery.toLowerCase();
    const results: typeof searchResults = [];
    
    // Search through filtered messages
    const messagesToSearch = settings.showSessionInit ? messages : 
      messages.filter(msg => !(msg.role === 'system' && msg.metadata?.systemSubtype === 'init'));
    
    // Limit search to first 200 messages for performance
    const searchLimit = Math.min(messagesToSearch.length, 200);
    
    for (let i = 0; i < searchLimit; i++) {
      const message = messagesToSearch[i];
      const messageResults: typeof searchResults[0]['matches'] = [];
      
      // Search in text segments
      message.segments.forEach((segment, segmentIndex) => {
        if (segment.type === 'text') {
          const text = segment.content.toLowerCase();
          let startIndex = 0;
          let matchIndex = text.indexOf(query, startIndex);
          
          while (matchIndex !== -1 && messageResults.length < 5) {
            messageResults.push({
              segmentIndex,
              text: segment.content.substring(Math.max(0, matchIndex - 20), Math.min(segment.content.length, matchIndex + query.length + 20)),
              start: matchIndex,
              end: matchIndex + query.length
            });
            startIndex = matchIndex + 1;
            matchIndex = text.indexOf(query, startIndex);
          }
        }
      });
      
      if (messageResults.length > 0) {
        results.push({
          messageIndex: i,
          matches: messageResults
        });
        
        if (results.length >= 50) break;
      }
    }
    
    setSearchResults(results);
    setCurrentSearchIndex(0);
  }, [debouncedSearchQuery, messages, settings.showSessionInit]);

  useEffect(() => {
    performSearch();
  }, [performSearch]);

  // Filter messages based on settings - moved here to be available for renderMessage
  const filteredMessages = useMemo(() => {
    if (settings.showSessionInit) {
      return messages;
    }
    return messages.filter(msg => !(msg.role === 'system' && msg.metadata?.systemSubtype === 'init'));
  }, [messages, settings.showSessionInit]);

  // Keyboard shortcuts for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 100);
      }
      
      // Escape to close search
      if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
        setSearchQuery('');
      }
      
      // Enter to go to next result
      if (e.key === 'Enter' && isSearchOpen && searchResults.length > 0) {
        e.preventDefault();
        navigateToSearchResult((currentSearchIndex + 1) % searchResults.length);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSearchOpen, searchResults, currentSearchIndex]);

  const navigateToSearchResult = (index: number) => {
    if (searchResults.length === 0 || !virtuosoRef.current) return;
    
    setCurrentSearchIndex(index);
    const result = searchResults[index];
    
    virtuosoRef.current.scrollToIndex({
      index: result.messageIndex,
      behavior: 'smooth',
      align: 'center'
    });
  };


  // Removed duplicate scrollToBottom - using the one defined above

  const toggleMessageCollapse = (messageId: string) => {
    setCollapsedMessages(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const toggleToolExpand = (toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  };

  // Copy ALL render functions from RichOutputView
  const renderToolCall = (tool: ToolCall, depth: number = 0) => {
    const isExpanded = !settings.collapseTools || expandedTools.has(tool.id);
    const isTaskAgent = tool.isSubAgent && tool.name === 'Task';
    const hasChildTools = tool.childToolCalls && tool.childToolCalls.length > 0;
    
    const bgColor = isTaskAgent 
      ? 'bg-interactive/10' 
      : depth > 0 
        ? 'bg-surface-tertiary/30' 
        : 'bg-surface-tertiary/50';
    
    const borderColor = isTaskAgent
      ? 'border-interactive/30'
      : 'border-border-primary/50';
    
    return (
      <div className={`rounded-md ${bgColor} overflow-hidden border ${borderColor} ${depth > 0 ? 'ml-4' : ''}`}>
        <button
          onClick={() => toggleToolExpand(tool.id)}
          className="w-full px-3 py-2 bg-surface-tertiary/30 flex items-center gap-2 hover:bg-surface-tertiary/50 transition-colors text-left"
        >
          {isTaskAgent ? (
            <svg className="w-3.5 h-3.5 text-interactive flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          ) : (
            <Wrench className="w-3.5 h-3.5 text-interactive-on-dark flex-shrink-0" />
          )}
          <span className="font-mono text-xs text-text-primary flex-1">
            {isTaskAgent ? 'Sub-Agent' : tool.name}
            {isTaskAgent && tool.subAgentType && (
              <span className="ml-2 text-interactive font-semibold">
                [{tool.subAgentType}]
              </span>
            )}
          </span>
          {tool.status === 'success' && <CheckCircle className="w-3.5 h-3.5 text-status-success flex-shrink-0" />}
          {tool.status === 'error' && <XCircle className="w-3.5 h-3.5 text-status-error flex-shrink-0" />}
          {tool.status === 'pending' && <Clock className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0 animate-pulse" />}
          {(settings.collapseTools || hasChildTools) && (
            isExpanded ? <ChevronDown className="w-3 h-3 text-text-tertiary" /> : <ChevronRight className="w-3 h-3 text-text-tertiary" />
          )}
        </button>
        
        {isExpanded && (
          <div className="px-3 py-2 text-xs">
            {tool.input && Object.keys(tool.input).length > 0 && (
              <div className="mb-2">
                <div className="text-text-tertiary mb-1">Parameters:</div>
                {formatToolInput(tool.name, tool.input)}
              </div>
            )}
            
            {hasChildTools && (
              <div className="mt-2">
                <div className="text-text-secondary text-xs font-semibold mb-2 flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                  Sub-agent Actions:
                </div>
                <div className="space-y-2">
                  {tool.childToolCalls!.map((childTool, idx) => (
                    <div key={`${tool.id}-child-${idx}`}>
                      {renderToolCall(childTool, depth + 1)}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {tool.result && (
              <div className="mt-2">
                <div className="text-text-tertiary mb-1">
                  {tool.result.isError ? 'Error:' : 'Result:'}
                </div>
                <div className={`${tool.result.isError ? 'text-status-error' : 'text-text-primary'}`}>
                  {formatToolResult(tool.name, tool.result.content)}
                </div>
              </div>
            )}
            
            {tool.status === 'pending' && !hasChildTools && (
              <div className="text-text-tertiary italic">Waiting for result...</div>
            )}
          </div>
        )}
      </div>
    );
  };

  const formatToolInput = (toolName: string, input: any): React.ReactNode => {
    switch (toolName) {
      case 'Read':
        return (
          <div className="font-mono text-xs space-y-0.5">
            {input.file_path && (
              <div className="flex items-center gap-1">
                <span className="text-text-tertiary">File:</span>
                <span className="text-interactive-on-dark truncate">{input.file_path}</span>
              </div>
            )}
            {input.offset && <div className="text-text-tertiary">Lines: {input.offset}-{input.offset + (input.limit || 2000)}</div>}
          </div>
        );
      
      case 'Edit':
      case 'MultiEdit':
        return (
          <div className="font-mono text-sm space-y-1">
            {input.file_path && <div>File: <span className="text-interactive-on-dark">{input.file_path}</span></div>}
            {toolName === 'MultiEdit' && input.edits && (
              <div>{input.edits.length} changes</div>
            )}
          </div>
        );
      
      case 'Write':
        return (
          <div className="font-mono text-sm space-y-1">
            {input.file_path && <div>File: <span className="text-interactive-on-dark">{input.file_path}</span></div>}
            {input.content && (
              <div>{input.content.split('\n').length} lines</div>
            )}
          </div>
        );
      
      case 'Bash':
        return (
          <div className="font-mono text-sm bg-bg-tertiary px-2 py-1 rounded">
            <span className="text-status-success">$</span> {input.command}
          </div>
        );
      
      case 'Grep':
        return (
          <div className="font-mono text-sm space-y-1">
            <div>Pattern: <span className="text-status-warning">"{input.pattern}"</span></div>
            {input.path && <div>Path: {input.path}</div>}
            {input.glob && <div>Files: {input.glob}</div>}
          </div>
        );
      
      case 'Task':
        return (
          <div className="text-sm space-y-1.5">
            {input.description && (
              <div className="flex items-start gap-2">
                <span className="text-text-tertiary">Task:</span>
                <span className="text-interactive font-medium">{input.description}</span>
              </div>
            )}
            {input.subagent_type && (
              <div className="flex items-start gap-2">
                <span className="text-text-tertiary">Agent Type:</span>
                <span className="text-status-warning font-mono text-xs">{input.subagent_type}</span>
              </div>
            )}
            {input.prompt && (
              <details className="mt-1">
                <summary className="cursor-pointer text-text-secondary hover:text-text-primary text-xs">
                  View Prompt
                </summary>
                <div className="mt-1 p-2 bg-surface-secondary rounded text-xs whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {input.prompt}
                </div>
              </details>
            )}
          </div>
        );
      
      case 'TodoWrite':
        return (
          <div className="text-sm space-y-1">
            {input.todos && input.todos.map((todo: any, idx: number) => {
              const icon = todo.status === 'completed' ? '✓' : 
                          todo.status === 'in_progress' ? '→' : '○';
              const color = todo.status === 'completed' ? 'text-status-success' : 
                           todo.status === 'in_progress' ? 'text-status-warning' : 'text-text-tertiary';
              return (
                <div key={idx} className={`${color} truncate`}>
                  {icon} {todo.content}
                </div>
              );
            })}
          </div>
        );
      
      default:
        return (
          <pre className="text-xs overflow-x-auto max-h-20">
            {JSON.stringify(input, null, 2)}
          </pre>
        );
    }
  };

  const formatToolResult = (toolName: string, result: string): React.ReactNode => {
    if (!result) {
      return <div className="text-sm text-text-tertiary italic">No result</div>;
    }
    
    try {
      const parsed = JSON.parse(result);
      
      if (toolName === 'Task' && Array.isArray(parsed)) {
        const textContent = parsed
          .filter(item => item.type === 'text' && item.text)
          .map(item => item.text)
          .join('\n\n');
        
        if (textContent) {
          return (
            <div className="text-sm text-text-primary whitespace-pre-wrap max-h-64 overflow-y-auto">
              {textContent}
            </div>
          );
        }
      }
      
      if (Array.isArray(parsed) && parsed[0]?.type === 'image') {
        return (
          <div className="text-sm text-text-secondary italic">
            [Image displayed to assistant]
          </div>
        );
      }
      
      return (
        <pre className="text-xs overflow-x-auto max-h-32">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      if (result.length > 300) {
        return (
          <details className="text-sm">
            <summary className="cursor-pointer text-text-secondary hover:text-text-primary">
              {result.substring(0, 100)}... (click to expand)
            </summary>
            <pre className="mt-2 text-xs whitespace-pre-wrap max-h-64 overflow-y-auto">{result}</pre>
          </details>
        );
      }
      
      return <pre className="text-sm whitespace-pre-wrap">{result}</pre>;
    }
  };

  // Highlight text for search results
  const highlightText = (text: string, messageIndex: number): React.ReactNode => {
    if (!searchQuery || searchResults.length === 0) {
      return text;
    }
    
    const result = searchResults.find(r => r.messageIndex === messageIndex);
    if (!result) return text;
    
    const query = searchQuery.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    
    const lowerText = text.toLowerCase();
    let matchIndex = lowerText.indexOf(query);
    
    while (matchIndex !== -1) {
      // Add text before match
      if (matchIndex > lastIndex) {
        parts.push(text.substring(lastIndex, matchIndex));
      }
      
      // Add highlighted match
      parts.push(
        <span key={matchIndex} className="bg-yellow-300 text-black px-0.5 rounded">
          {text.substring(matchIndex, matchIndex + query.length)}
        </span>
      );
      
      lastIndex = matchIndex + query.length;
      matchIndex = lowerText.indexOf(query, lastIndex);
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    
    return <>{parts}</>;
  };

  // Copy EXACT renderMessage function from RichOutputView - this is HUGE but we need it all
  const renderMessage = (message: ConversationMessage, index: number, userMessageIndex?: number) => {
    const isCollapsed = collapsedMessages.has(message.id);
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system';
    const hasTextContent = message.segments.some(seg => seg.type === 'text');
    const textContent = message.segments
      .filter(seg => seg.type === 'text')
      .map(seg => seg.type === 'text' ? seg.content : '')
      .join('\n\n');
    
    const hasToolCalls = message.segments.some(seg => seg.type === 'tool_call');
    const hasThinking = message.segments.some(seg => seg.type === 'thinking');
    
    const prevMessage = index > 0 ? filteredMessages[index - 1] : null;
    const needsExtraSpacing = prevMessage && (
      (prevMessage.role !== message.role) || 
      (hasThinking && !prevMessage.segments.some(seg => seg.type === 'thinking'))
    );
    
    // Check if this message has search results
    const hasSearchMatch = searchResults.some(r => r.messageIndex === index);
    const isCurrentSearchResult = searchResults[currentSearchIndex]?.messageIndex === index;
    
    // Special rendering for system messages
    if (isSystem) {
      if (message.metadata?.systemSubtype === 'init') {
        const info = message.segments.find(seg => seg.type === 'system_info');
        if (info?.type === 'system_info') {
          return (
            <div
              key={message.id}
              className={`
                rounded-lg transition-all bg-surface-tertiary border border-border-primary
                ${settings.compactMode ? 'p-3' : 'p-4'}
              `}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-full p-2 bg-interactive/10 text-interactive-on-dark">
                  <Settings2 className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-semibold text-text-primary">Session Started</span>
                    <span className="text-sm text-text-tertiary">
                      {formatDistanceToNow(parseTimestamp(message.timestamp))}
                    </span>
                  </div>
                  <div className="text-sm text-text-secondary space-y-1">
                    <div>Model: <span className="text-text-primary font-mono">{info.info.model}</span></div>
                    <div>Working Directory: <span className="text-text-primary font-mono text-xs">{info.info.cwd}</span></div>
                    <div>
                      Tools: <span className="text-text-tertiary">{info.info.tools?.length || 0} available</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }
      } else if (message.metadata?.systemSubtype === 'error') {
        const errorInfo = message.segments.find(seg => seg.type === 'system_info')?.info;
        const errorMessage = errorInfo?.message || textContent;
        const errorTitle = errorInfo?.error || 'Session Error';
        
        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-status-error/10 border border-status-error/30
              ${settings.compactMode ? 'p-3' : 'p-4'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full p-2 bg-status-error/20 text-status-error">
                <XCircle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-status-error">{errorTitle}</span>
                  <span className="text-sm text-text-tertiary">
                    {formatDistanceToNow(parseTimestamp(message.timestamp))}
                  </span>
                  {message.metadata?.duration && (
                    <span className="text-xs text-text-tertiary">
                      · {(message.metadata.duration / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                <div className="text-sm text-text-primary whitespace-pre-wrap">
                  {errorMessage}
                </div>
              </div>
            </div>
          </div>
        );
      } else if (message.metadata?.systemSubtype === 'context_compacted') {
        const infoSegment = message.segments.find(seg => seg.type === 'system_info');
        const helpMessage = infoSegment?.type === 'system_info' ? infoSegment.info.message : 
          'Context has been compacted. You can continue chatting - your next message will automatically include the context summary above.';
        
        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-status-warning/10 border border-status-warning/30
              ${settings.compactMode ? 'p-3' : 'p-4'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full p-2 bg-status-warning/20 text-status-warning">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-semibold text-status-warning">Context Compacted</span>
                  <span className="text-sm text-text-tertiary">
                    {formatDistanceToNow(parseTimestamp(message.timestamp))}
                  </span>
                </div>
                
                <div className="bg-surface-secondary rounded-lg p-3 mb-3 border border-border-primary">
                  <div className="text-sm text-text-secondary font-mono whitespace-pre-wrap">
                    {textContent}
                  </div>
                </div>
                
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-status-success mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-text-primary">
                    <span className="font-medium">Ready to continue!</span> {helpMessage}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      } else if (message.metadata?.systemSubtype === 'git_operation') {
        const rawOutput = message.segments.find(seg => seg.type === 'text')?.content || textContent;
        const isSuccess = rawOutput.includes('✓') || rawOutput.includes('Successfully');
        
        const lines = rawOutput.split('\n');
        const mainMessage = lines.filter(line => !line.includes('🔄 GIT OPERATION') && line.trim()).join('\n');
        
        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all border 
              ${isSuccess 
                ? 'bg-status-success/10 border-status-success/30' 
                : 'bg-interactive/10 border-interactive/30'
              }
              ${settings.compactMode ? 'p-3' : 'p-4'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-start gap-3">
              <div className={`
                rounded-full p-2 
                ${isSuccess 
                  ? 'bg-status-success/20 text-status-success' 
                  : 'bg-interactive/20 text-interactive-on-dark'
                }
              `}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`
                    font-semibold 
                    ${isSuccess ? 'text-status-success' : 'text-interactive-on-dark'}
                  `}>
                    🔄 Git Operation
                  </span>
                  <span className="text-sm text-text-tertiary">
                    {formatDistanceToNow(parseTimestamp(message.timestamp))}
                  </span>
                </div>
                <div className="space-y-2">
                  {mainMessage.split('\n').map((line, idx) => {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) return null;
                    
                    if (trimmedLine.startsWith('✓')) {
                      return (
                        <div key={idx} className="flex items-center gap-2 text-status-success font-medium">
                          <span className="text-base">✓</span>
                          <span>{trimmedLine.substring(1).trim()}</span>
                        </div>
                      );
                    } else if (trimmedLine.startsWith('Commit message:')) {
                      return (
                        <div key={idx} className="text-sm text-text-secondary italic">
                          {trimmedLine}
                        </div>
                      );
                    } else if (trimmedLine.includes('Git output:')) {
                      return (
                        <div key={idx} className="text-sm text-text-secondary font-medium border-t border-border-primary pt-2 mt-2">
                          {trimmedLine}
                        </div>
                      );
                    } else {
                      return (
                        <div key={idx} className="text-text-primary">
                          {trimmedLine}
                        </div>
                      );
                    }
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      } else if (message.metadata?.systemSubtype === 'git_error') {
        const rawOutput = message.segments.find(seg => seg.type === 'text')?.content || textContent;
        
        const lines = rawOutput.split('\n');
        const mainMessage = lines.filter(line => line.trim()).join('\n');
        
        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-status-error/10 border border-status-error/30
              ${settings.compactMode ? 'p-3' : 'p-4'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full p-2 bg-status-error/20 text-status-error">
                <XCircle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-status-error">Git Operation Failed</span>
                  <span className="text-sm text-text-tertiary">
                    {formatDistanceToNow(parseTimestamp(message.timestamp))}
                  </span>
                </div>
                <div className="space-y-2">
                  {mainMessage.split('\n').map((line, idx) => {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) return null;
                    
                    if (trimmedLine.startsWith('✗')) {
                      return (
                        <div key={idx} className="flex items-center gap-2 text-status-error font-medium">
                          <span className="text-base">✗</span>
                          <span>{trimmedLine.substring(1).trim()}</span>
                        </div>
                      );
                    } else if (trimmedLine.includes('Git output:')) {
                      return (
                        <div key={idx} className="text-sm text-text-secondary font-medium border-t border-status-error/20 pt-2 mt-2">
                          {trimmedLine}
                        </div>
                      );
                    } else {
                      return (
                        <div key={idx} className="text-sm text-status-error font-mono bg-surface-secondary/50 p-2 rounded border border-status-error/20">
                          {trimmedLine}
                        </div>
                      );
                    }
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      }
    }
    
    return (
      <div
        key={message.id}
        ref={isUser && userMessageIndex !== undefined ? (el) => {
          if (el) userMessageRefs.current.set(userMessageIndex, el);
        } : undefined}
        className={`
          rounded-lg transition-all
          ${isUser ? 'bg-surface-secondary' : hasThinking ? 'bg-surface-primary/50' : 'bg-surface-primary'}
          ${hasToolCalls ? 'bg-surface-tertiary/30' : ''}
          ${settings.compactMode ? 'p-3' : 'p-4'}
          ${needsExtraSpacing ? 'mt-4' : ''}
          ${hasSearchMatch ? 'ring-2 ring-yellow-400/50' : ''}
          ${isCurrentSearchResult ? 'bg-yellow-100/10' : ''}
        `}
      >
        <div className="flex items-center gap-2 mb-2">
          <div className={`
            rounded-full p-1.5 flex-shrink-0
            ${isUser ? 'bg-status-success/20 text-status-success' : 'bg-interactive/20 text-interactive-on-dark'}
          `}>
            {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
          </div>
          <div className="flex-1 flex items-baseline gap-2">
            <span className="font-medium text-text-primary text-sm">
              {isUser ? 'You' : getAgentName(message.metadata?.agent)}
            </span>
            <span className="text-xs text-text-tertiary">
              {formatDistanceToNow(parseTimestamp(message.timestamp))}
            </span>
            {message.metadata?.duration && (
              <span className="text-xs text-text-tertiary">
                · {(message.metadata.duration / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          {hasTextContent && textContent.length > 200 && (
            <button
              onClick={() => toggleMessageCollapse(message.id)}
              className="text-text-tertiary hover:text-text-secondary transition-colors"
            >
              {isCollapsed ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          )}
        </div>

        <div className="ml-7 space-y-2">
          {settings.showThinking && message.segments
            .filter(seg => seg.type === 'thinking')
            .map((seg, idx) => {
              if (seg.type === 'thinking') {
                return (
                  <div key={`${message.id}-thinking-${idx}`} className="relative">
                    <div className="absolute -left-7 top-0 w-1 h-full bg-interactive/20 rounded-full" />
                    <div className="pl-4 pr-2 py-2">
                      <div className="text-sm thinking-content italic text-text-secondary">
                        <MarkdownPreview content={seg.content} />
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })
          }
          
          {hasTextContent && (
            <div className={`${isCollapsed ? 'max-h-20 overflow-hidden relative' : ''}`}>
              {isUser ? (
                <div className="text-text-primary whitespace-pre-wrap font-medium">
                  {searchQuery ? highlightText(textContent, index) : textContent}
                </div>
              ) : (
                <div className="rich-output-markdown">
                  {searchQuery ? (
                    <div dangerouslySetInnerHTML={{ __html: textContent.replace(
                      new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                      match => `<span class="bg-yellow-300 text-black px-0.5 rounded">${match}</span>`
                    )}} />
                  ) : (
                    <MarkdownPreview content={textContent} />
                  )}
                </div>
              )}
              {isCollapsed && (
                <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-surface-secondary to-transparent pointer-events-none" />
              )}
            </div>
          )}
          
          {settings.showToolCalls && message.segments
            .filter(seg => seg.type === 'tool_call')
            .map((seg, idx) => {
              if (seg.type === 'tool_call') {
                return (
                  <div key={`${message.id}-tool-${idx}`}>
                    {renderToolCall(seg.tool)}
                  </div>
                );
              }
              return null;
            })
          }
        </div>
      </div>
    );
  };

  const getAgentName = (agent?: string) => {
    switch (agent) {
      case 'claude': return 'Claude';
      case 'gpt-4':
      case 'openai': return 'GPT-4';
      case 'gemini':
      case 'google': return 'Gemini';
      default: return 'Assistant';
    }
  };

  const isWaitingForResponse = useMemo(() => {
    if (sessionStatus === 'running') {
      return true;
    }
    
    if (sessionStatus === 'waiting' && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      return lastMessage.role === 'user';
    }
    
    return false;
  }, [messages, sessionStatus]);

  // This is the KEY difference - use Virtuoso for rendering
  const renderMessageItem = useCallback((index: number) => {
    const msg = filteredMessages[index];
    const isUser = msg.role === 'user';
    let userMessageIndex: number | undefined;
    
    if (isUser) {
      let count = 0;
      for (let i = 0; i < index; i++) {
        if (filteredMessages[i].role === 'user') count++;
      }
      userMessageIndex = count;
    }
    
    return renderMessage(msg, index, userMessageIndex);
  }, [filteredMessages, collapsedMessages, expandedTools, settings]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary">Loading conversation...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-status-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary relative">
      {/* Search Bar - positioned well below Prompt History */}
      {isSearchOpen && (
        <div className="absolute top-56 right-4 z-20 flex items-center gap-2 bg-surface-secondary border border-border-primary rounded-lg p-2 shadow-lg">
          <Search className="w-4 h-4 text-text-tertiary" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="bg-transparent text-text-primary placeholder-text-tertiary outline-none w-64"
            autoFocus
          />
          {searchResults.length > 0 && (
            <div className="flex items-center gap-1 text-xs text-text-tertiary">
              <span>{currentSearchIndex + 1}/{searchResults.length}</span>
              <button
                onClick={() => navigateToSearchResult(Math.max(0, currentSearchIndex - 1))}
                className="p-1 hover:bg-surface-hover rounded"
              >
                <ChevronUp className="w-3 h-3" />
              </button>
              <button
                onClick={() => navigateToSearchResult((currentSearchIndex + 1) % searchResults.length)}
                className="p-1 hover:bg-surface-hover rounded"
              >
                <ChevronDown className="w-3 h-3" />
              </button>
            </div>
          )}
          <button
            onClick={() => {
              setIsSearchOpen(false);
              setSearchQuery('');
            }}
            className="p-1 hover:bg-surface-hover rounded"
          >
            <X className="w-4 h-4 text-text-tertiary" />
          </button>
        </div>
      )}
      
      {/* Search Toggle Button - positioned below Prompt History */}
      {!isSearchOpen && (
        <button
          onClick={() => {
            setIsSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 100);
          }}
          className="absolute top-56 right-4 z-20 p-2 bg-surface-secondary hover:bg-surface-hover border border-border-primary rounded-lg transition-colors"
          title="Search (Cmd/Ctrl + F)"
        >
          <Search className="w-4 h-4 text-text-secondary" />
        </button>
      )}

      <div className="flex-1 relative">
        <Virtuoso
          ref={virtuosoRef}
          scrollerRef={scrollerRef}
          data={filteredMessages}
          totalCount={filteredMessages.length + (isWaitingForResponse ? 1 : 0)}
          defaultItemHeight={80}
          itemContent={(index) => {
            // Handle the waiting placeholder
            if (index === filteredMessages.length && isWaitingForResponse) {
              if (filteredMessages.length === 0 || 
                  (filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1].role === 'user')) {
                return (
                  <div className={`mx-auto ${settings.compactMode ? 'max-w-6xl' : 'max-w-5xl'} px-4 py-4`}>
                    <ThinkingPlaceholder />
                  </div>
                );
              } else {
                return (
                  <div className={`mx-auto ${settings.compactMode ? 'max-w-6xl' : 'max-w-5xl'} px-4 py-4`}>
                    <InlineWorkingIndicator />
                  </div>
                );
              }
            }
            
            return (
              <div className={`mx-auto ${settings.compactMode ? 'max-w-6xl' : 'max-w-5xl'} px-4`}>
                {index === 0 && <div className="h-4" />}
                {renderMessageItem(index)}
                {index === filteredMessages.length - 1 && <div className="h-8" />}
              </div>
            );
          }}
          followOutput={(isAtBottom) => {
            // If we're at the bottom, follow new content smoothly
            // Otherwise, don't auto-scroll
            return isAtBottom ? 'smooth' : false;
          }}
          alignToBottom={true}
          atBottomStateChange={(atBottom) => {
            console.log('[ScrollDebug] atBottomStateChange:', atBottom);
            wasAtBottomRef.current = atBottom;
            setShowScrollButton(!atBottom);
          }}
          overscan={200}
          increaseViewportBy={{ top: 200, bottom: 0 }}
          className="scrollbar-thin scrollbar-thumb-border-secondary scrollbar-track-transparent hover:scrollbar-thumb-border-primary"
          style={{
            height: '100%',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--color-border-secondary) transparent'
          }}
        />
        
        {showScrollButton && (
          <div className="absolute bottom-4 left-0 right-0 flex justify-center pointer-events-none">
            <button
              onClick={() => scrollToBottom('smooth')}
              className="pointer-events-auto p-3 bg-interactive hover:bg-interactive-hover text-white rounded-full shadow-lg transition-all hover:scale-110 flex items-center gap-2"
              title="Scroll to bottom"
            >
              <ArrowDown className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

VirtuosoRichOutputView.displayName = 'VirtuosoRichOutputView';