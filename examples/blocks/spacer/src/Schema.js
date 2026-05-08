const SpacerSchema = {
  title: 'Spacer',
  fieldsets: [
    {
      id: 'default',
      title: 'Spacer',
      fields: ['height'],
    },
  ],
  properties: {
    height: {
      title: 'Altura (px)',
      description: 'Espacio en píxeles entre bloques',
      type: 'integer',
      default: 100,
      minimum: 0,
      maximum: 2000,
    },
  },
  required: [],
};

export default SpacerSchema;
