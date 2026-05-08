/**
 * MF Blocks Control Panel
 * Manages Module Federation blocks from Site Setup.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Helmet } from '@plone/volto/helpers';
import {
  Container, Table, Button, Header, Segment, Label, Icon,
  Confirm, Modal, Form, Message, Divider,
} from 'semantic-ui-react';
import { useSelector } from 'react-redux';
import { Link, useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { defineMessages, useIntl } from 'react-intl';
import { useClient } from '@plone/volto/hooks/client/useClient';
import VIcon from '@plone/volto/components/theme/Icon/Icon';
import Toolbar from '@plone/volto/components/manage/Toolbar/Toolbar';
import backSVG from '@plone/volto/icons/back.svg';

interface MFBlockEntry {
  uid: string;
  title: string;
  block_id: string;
  remote_name: string;
  version: string;
  group: string;
  active: boolean;
  review_state: string;
  url: string;
  path: string;
  created: string;
  modified: string;
}

const messages = defineMessages({
  back: { id: 'Back', defaultMessage: 'Back' },
});

const stateColors: Record<string, string> = {
  published: 'green',
  private: 'red',
  pending: 'yellow',
};

const stateLabels: Record<string, string> = {
  published: 'Published',
  private: 'Draft',
  pending: 'Pending',
};

const groupOptions = [
  { key: 'bricks', value: 'bricks', text: 'Bricks' },
  { key: 'common', value: 'common', text: 'Common' },
  { key: 'text', value: 'text', text: 'Text' },
  { key: 'media', value: 'media', text: 'Media' },
  { key: 'mostUsed', value: 'mostUsed', text: 'Most Used' },
];

const MFBlocksControlPanel: React.FC = () => {
  const [blocks, setBlocks] = useState<MFBlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Install modal state
  const [showInstall, setShowInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    block_id: '',
    remote_name: '',
    remote_module: './block',
    version: '1.0.0',
    group: 'bricks',
  });
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Update modal state
  const [updateTarget, setUpdateTarget] = useState<MFBlockEntry | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const [updateFile, setUpdateFile] = useState<File | null>(null);
  const updateFileRef = useRef<HTMLInputElement>(null);

  const intl = useIntl();
  const { pathname } = useLocation();
  const isClient = useClient();

  const token = useSelector((state: any) => state.userSession?.token);

  const apiPath =
    (typeof window !== 'undefined' && (window as any).env?.apiPath) ||
    (typeof window !== 'undefined'
      ? `${window.location.origin}/++api++`
      : '');

  const fetchBlocks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${apiPath}/@mfblocks-manage`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setBlocks(data.blocks || []);
    } catch (err: any) {
      setError(err.message || 'Error loading blocks');
    } finally {
      setLoading(false);
    }
  }, [apiPath, token]);

  useEffect(() => {
    if (token) fetchBlocks();
  }, [fetchBlocks, token]);

  const doAction = async (uid: string, action: string) => {
    setActionLoading(uid);
    setError('');
    setSuccess('');
    try {
      const resp = await fetch(`${apiPath}/@mfblocks-manage`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ uid, action }),
      });
      if (!resp.ok) {
        const errData = await resp.json();
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }
      const result = await resp.json();
      if (action === 'delete') {
        setSuccess(`Block "${result.title}" deleted.`);
      }
      await fetchBlocks();
      if (['publish', 'retract', 'activate', 'deactivate', 'delete'].includes(action)) {
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
      setConfirmDelete(null);
    }
  };

  // Auto-generate remote_name from title
  const handleTitleChange = (val: string) => {
    const id = val
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const remoteName = 'volto' + val
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('') + 'Block';

    setFormData((prev) => ({
      ...prev,
      title: val,
      block_id: id,
      remote_name: remoteName,
    }));
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleInstall = async () => {
    if (!bundleFile) {
      setError('Please select a .tar.gz file');
      return;
    }
    if (!formData.title || !formData.block_id || !formData.remote_name) {
      setError('Please fill in all required fields');
      return;
    }

    setInstalling(true);
    setError('');
    try {
      const base64 = await fileToBase64(bundleFile);

      const resp = await fetch(`${apiPath}/@mfblocks-manage`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          bundle_data: base64,
          bundle_filename: bundleFile.name,
          auto_publish: true,
        }),
      });

      const result = await resp.json();
      if (!resp.ok) {
        throw new Error(result.error || `HTTP ${resp.status}`);
      }

      setSuccess(result.message || `Block "${formData.title}" installed.`);
      setShowInstall(false);
      resetForm();
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInstalling(false);
    }
  };

  const handleUpdate = async () => {
    if (!updateTarget || !updateFile) {
      setError('Please select a .tar.gz file');
      return;
    }

    setUpdating(true);
    setError('');
    try {
      const base64 = await fileToBase64(updateFile);

      const resp = await fetch(`${apiPath}/@mfblocks-manage`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          uid: updateTarget.uid,
          action: 'update',
          bundle_data: base64,
          bundle_filename: updateFile.name,
          version: updateVersion || undefined,
        }),
      });

      const result = await resp.json();
      if (!resp.ok) {
        throw new Error(result.error || `HTTP ${resp.status}`);
      }

      setSuccess(`Block "${updateTarget.title}" updated successfully.`);
      closeUpdateModal();
      await fetchBlocks();
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUpdating(false);
    }
  };

  const openUpdateModal = (block: MFBlockEntry) => {
    setUpdateTarget(block);
    setUpdateVersion(block.version);
    setUpdateFile(null);
  };

  const closeUpdateModal = () => {
    setUpdateTarget(null);
    setUpdateVersion('');
    setUpdateFile(null);
    if (updateFileRef.current) updateFileRef.current.value = '';
  };

  const resetForm = () => {
    setFormData({
      title: '',
      block_id: '',
      remote_name: '',
      remote_module: './block',
      version: '1.0.0',
      group: 'bricks',
    });
    setBundleFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <Container id="mfblocks-controlpanel" style={{ padding: '2em 0' }}>
      <Helmet title="MF Blocks Manager" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5em' }}>
        <div>
          <Header as="h1" style={{ marginBottom: '0.2em' }}>
            Module Federation Blocks
          </Header>
          <p style={{ color: '#666', margin: 0 }}>
            Manage remote blocks loaded via Module Federation.
          </p>
        </div>
        <Button primary icon labelPosition="left" onClick={() => setShowInstall(true)}>
          <Icon name="plus" />
          Install Block
        </Button>
      </div>

      {error && (
        <Message negative onDismiss={() => setError('')}>
          <Message.Header>Error</Message.Header>
          <p>{error}</p>
        </Message>
      )}

      {success && (
        <Message positive onDismiss={() => setSuccess('')}>
          <p>{success}</p>
        </Message>
      )}

      <Segment loading={loading}>
        <Table celled striped>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Block</Table.HeaderCell>
              <Table.HeaderCell>Block ID</Table.HeaderCell>
              <Table.HeaderCell>Version</Table.HeaderCell>
              <Table.HeaderCell>Group</Table.HeaderCell>
              <Table.HeaderCell>State</Table.HeaderCell>
              <Table.HeaderCell>Active</Table.HeaderCell>
              <Table.HeaderCell>Actions</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {blocks.length === 0 && !loading && (
              <Table.Row>
                <Table.Cell colSpan="7" textAlign="center" style={{ color: '#999', padding: '2em' }}>
                  No MF blocks registered. Use "Install Block" to add one.
                </Table.Cell>
              </Table.Row>
            )}
            {blocks.map((block) => (
              <Table.Row key={block.uid}>
                <Table.Cell>
                  <strong>{block.title}</strong>
                  <br />
                  <small style={{ color: '#888' }}>{block.remote_name}</small>
                </Table.Cell>
                <Table.Cell>
                  <code>{block.block_id}</code>
                </Table.Cell>
                <Table.Cell>{block.version}</Table.Cell>
                <Table.Cell>{block.group}</Table.Cell>
                <Table.Cell>
                  <Label color={stateColors[block.review_state] as any || 'grey'} size="small">
                    {stateLabels[block.review_state] || block.review_state}
                  </Label>
                </Table.Cell>
                <Table.Cell textAlign="center">
                  {block.active ? (
                    <Icon name="check circle" color="green" />
                  ) : (
                    <Icon name="times circle" color="red" />
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Button.Group size="small">
                    {block.review_state !== 'published' ? (
                      <Button
                        positive
                        icon="check"
                        content="Publish"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'publish')}
                      />
                    ) : (
                      <Button
                        icon="hide"
                        content="Retract"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'retract')}
                      />
                    )}
                    <Button
                      color="blue"
                      icon="sync"
                      content="Update"
                      loading={actionLoading === block.uid}
                      onClick={() => openUpdateModal(block)}
                    />
                    {block.active ? (
                      <Button
                        icon="pause"
                        content="Deactivate"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'deactivate')}
                      />
                    ) : (
                      <Button
                        icon="play"
                        content="Activate"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'activate')}
                      />
                    )}
                    <Button
                      negative
                      icon="trash"
                      loading={actionLoading === block.uid}
                      onClick={() => setConfirmDelete(block.uid)}
                    />
                  </Button.Group>
                  <Confirm
                    open={confirmDelete === block.uid}
                    header="Delete Block"
                    content={`Are you sure you want to delete "${block.title}"? This action cannot be undone.`}
                    confirmButton="Delete"
                    cancelButton="Cancel"
                    onCancel={() => setConfirmDelete(null)}
                    onConfirm={() => doAction(block.uid, 'delete')}
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>

        <div style={{ marginTop: '1em', color: '#888', fontSize: '0.9em' }}>
          Total: {blocks.length} block(s)
        </div>
      </Segment>

      {/* Install Modal */}
      <Modal
        open={showInstall}
        onClose={() => { setShowInstall(false); resetForm(); }}
        size="small"
        closeIcon
      >
        <Modal.Header>Install New MF Block</Modal.Header>
        <Modal.Content>
          <Form>
            <Form.Input
              label="Block Name"
              placeholder="e.g. Hero Banner"
              value={formData.title}
              onChange={(_, { value }) => handleTitleChange(value as string)}
              required
            />

            <Form.Group widths="equal">
              <Form.Input
                label="Block ID"
                placeholder="hero-banner"
                value={formData.block_id}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, block_id: value as string }))
                }
                required
              />
              <Form.Input
                label="Version"
                placeholder="1.0.0"
                value={formData.version}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, version: value as string }))
                }
              />
            </Form.Group>

            <Form.Group widths="equal">
              <Form.Input
                label="Remote Name"
                placeholder="voltoHeroBannerBlock"
                value={formData.remote_name}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, remote_name: value as string }))
                }
                required
              />
              <Form.Input
                label="Remote Module"
                placeholder="./block"
                value={formData.remote_module}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, remote_module: value as string }))
                }
              />
            </Form.Group>

            <Form.Select
              label="Group"
              options={groupOptions}
              value={formData.group}
              onChange={(_, { value }) =>
                setFormData((prev) => ({ ...prev, group: value as string }))
              }
            />

            <Divider />

            <Form.Field required>
              <label>Bundle (.tar.gz)</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".tar.gz,.tgz"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setBundleFile(file);
                }}
              />
              {bundleFile && (
                <small style={{ color: '#888' }}>
                  {bundleFile.name} ({(bundleFile.size / 1024).toFixed(1)} KB)
                </small>
              )}
            </Form.Field>
          </Form>
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={() => { setShowInstall(false); resetForm(); }}>
            Cancel
          </Button>
          <Button
            primary
            icon="upload"
            content="Install & Publish"
            loading={installing}
            onClick={handleInstall}
          />
        </Modal.Actions>
      </Modal>

      {/* Update Modal */}
      <Modal
        open={!!updateTarget}
        onClose={closeUpdateModal}
        size="small"
        closeIcon
      >
        <Modal.Header>Update Block: {updateTarget?.title}</Modal.Header>
        <Modal.Content>
          <Form>
            <Message info>
              <p>
                Upload a new bundle to replace the current one.
                The block configuration (ID, name, group) will remain unchanged.
              </p>
            </Message>

            <Form.Input
              label="New Version"
              placeholder={updateTarget?.version || '1.0.0'}
              value={updateVersion}
              onChange={(_, { value }) => setUpdateVersion(value as string)}
            />

            <Form.Field required>
              <label>New Bundle (.tar.gz)</label>
              <input
                ref={updateFileRef}
                type="file"
                accept=".tar.gz,.tgz"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setUpdateFile(file);
                }}
              />
              {updateFile && (
                <small style={{ color: '#888' }}>
                  {updateFile.name} ({(updateFile.size / 1024).toFixed(1)} KB)
                </small>
              )}
            </Form.Field>
          </Form>
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={closeUpdateModal}>
            Cancel
          </Button>
          <Button
            primary
            icon="sync"
            content="Update Block"
            loading={updating}
            disabled={!updateFile}
            onClick={handleUpdate}
          />
        </Modal.Actions>
      </Modal>
      {isClient && createPortal(
        <Toolbar pathname={pathname} hideDefaultViewButtons
          inner={
            <Link to="/controlpanel" className="item">
              <VIcon name={backSVG} aria-label={intl.formatMessage(messages.back)}
                className="contents circled" size="30px"
                title={intl.formatMessage(messages.back)} />
            </Link>
          }
        />,
        document.getElementById('toolbar'),
      )}
    </Container>
  );
};

export default MFBlocksControlPanel;
