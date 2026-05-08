import SpacerView from './View';
import SpacerEdit from './Edit';
import SpacerSchema from './Schema';

const SpacerBlock = {
  id: 'spacer',
  title: 'Spacer',
  icon: null,
  group: 'common',
  view: SpacerView,
  edit: SpacerEdit,
  schema: SpacerSchema,
  restricted: false,
  mostUsed: false,
  blockHasOwnFocusManagement: false,
  sidebarTab: 1,
};

export default SpacerBlock;
