import React from 'react';

const SpacerView = ({ data }) => {
  const height = Math.max(0, Math.min(Number(data?.height) || 100, 2000));

  return <div style={{ height: `${height}px` }} />;
};

export default SpacerView;
