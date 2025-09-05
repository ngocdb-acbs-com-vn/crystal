import React from 'react';
import { GitCommands } from '../../types/session';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Checkbox, Textarea } from '../ui/Input';
import { Card } from '../ui/Card';

interface CommitMessageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  dialogType: 'squash' | 'rebase';
  gitCommands: GitCommands | null;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  shouldSquash: boolean;
  setShouldSquash: (should: boolean) => void;
  shouldGenerateMessage: boolean;
  setShouldGenerateMessage: (should: boolean) => void;
  onConfirm: (message: string) => void;
  onGenerateMessage: () => void;
  isMerging: boolean;
  isGeneratingMessage: boolean;
}

export const CommitMessageDialog: React.FC<CommitMessageDialogProps> = ({
  isOpen,
  onClose,
  dialogType,
  gitCommands,
  commitMessage,
  setCommitMessage,
  shouldSquash,
  setShouldSquash,
  shouldGenerateMessage,
  setShouldGenerateMessage,
  onConfirm,
  onGenerateMessage,
  isMerging,
  isGeneratingMessage,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader>
        {dialogType === 'squash'
          ? `Squash and Rebase to ${gitCommands?.mainBranch || 'Main'}`
          : `Rebase from ${gitCommands?.mainBranch || 'Main'}`
        }
      </ModalHeader>
      
      <ModalBody>
          <div className="space-y-4">
            {dialogType === 'squash' && (
              <Card variant="bordered" padding="md" className="bg-surface-secondary">
                <div className="space-y-3">
                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="shouldSquash"
                      label="Squash commits"
                      checked={shouldSquash}
                      onChange={(e) => setShouldSquash(e.target.checked)}
                      className="flex-1"
                    />
                    <div className="text-sm text-text-secondary ml-6">
                      {shouldSquash ? "Combine all commits into a single commit" : "Keep all commits and preserve history"}
                    </div>
                  </div>
                  
                  {shouldSquash && (
                    <div className="flex items-center space-x-3 pl-6 border-l-2 border-border-secondary">
                      <Checkbox
                        id="shouldGenerateMessage"
                        label="Generate commit message"
                        checked={shouldGenerateMessage}
                        onChange={async (e) => {
                          console.log('[CommitMessageDialog] Generate checkbox clicked:', e.target.checked);
                          setShouldGenerateMessage(e.target.checked);
                          if (e.target.checked) {
                            console.log('[CommitMessageDialog] Calling onGenerateMessage');
                            try {
                              await onGenerateMessage();
                            } catch (error) {
                              console.error('[CommitMessageDialog] Error in onGenerateMessage:', error);
                            }
                          }
                        }}
                        className="flex-1"
                      />
                      <div className="text-sm text-text-secondary ml-6">
                        Auto-generate conventional commit message using Claude
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}
            
            <Textarea
              label="Commit Message"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              rows={8}
              disabled={(dialogType === 'squash' && !shouldSquash) || isGeneratingMessage}
              placeholder={
                isGeneratingMessage 
                  ? "Generating commit message with Claude..."
                  : dialogType === 'squash' 
                    ? (shouldSquash ? "Enter commit message..." : "Not needed when preserving commits") 
                    : "Enter commit message..."
              }
              helperText={
                isGeneratingMessage
                  ? "Claude is analyzing changes and generating a conventional commit message..."
                  : dialogType === 'squash'
                    ? (shouldSquash 
                        ? `This message will be used for the single squashed commit. Max 120 characters for conventional format.`
                        : `Original commit messages will be preserved.`)
                    : `This message will be used when rebasing.`
              }
              fullWidth
              className="font-mono text-sm"
            />

            {dialogType === 'squash' && (
              <Card variant="bordered" padding="md" className="bg-surface-secondary">
                <h4 className="text-sm font-medium text-text-primary mb-2">Git commands to be executed:</h4>
                <div className="space-y-1">
                  {shouldSquash ? (
                    gitCommands?.squashCommands?.map((cmd, idx) => (
                      <Card key={idx} variant="bordered" padding="sm" className="bg-surface-tertiary text-text-primary font-mono text-xs">
                        {cmd}
                      </Card>
                    ))
                  ) : (
                    <>
                      <Card variant="bordered" padding="sm" className="bg-surface-tertiary text-text-primary font-mono text-xs">
                        git checkout {gitCommands?.mainBranch || 'main'}
                      </Card>
                      <Card variant="bordered" padding="sm" className="bg-surface-tertiary text-text-primary font-mono text-xs">
                        git rebase {gitCommands?.currentBranch || 'feature-branch'}
                      </Card>
                    </>
                  )}
                </div>
              </Card>
            )}
          </div>
      </ModalBody>
      
      <ModalFooter className="flex justify-end gap-3">
        <Button onClick={onClose} variant="ghost">
          Cancel
        </Button>
        <Button
          onClick={() => onConfirm(commitMessage)}
          disabled={(shouldSquash && !commitMessage.trim()) || isMerging}
          loading={isMerging}
        >
          {isMerging ? 'Processing...' : (dialogType === 'squash' ? (shouldSquash ? 'Squash & Rebase' : 'Rebase') : 'Rebase')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}; 