select * from FCT_GroundUnitFormationElementTemplates where FormationTemplateID not in (select TemplateID from FCT_GroundUnitFormationTemplate)

select * from FCT_GroundUnitFormation where ReplacementTemplateID not in (select TemplateID from FCT_GroundUnitFormationTemplate)

select * from FCT_GroundUnitFormation where OriginalTemplateID not in (select TemplateID from FCT_GroundUnitFormationTemplate)