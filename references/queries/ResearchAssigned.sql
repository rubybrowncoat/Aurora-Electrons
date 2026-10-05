with CTE_Commanders as
(
	SELECT
		cm.CommanderID
		,cm.Name
		,cm.ResSpecID
		,bnLabs.BonusValue as Labs
		,ifnull(bnBonus.BonusValue, 1.0) as BonusValue
		,round(21 + (c.GameTime - cm.CareerStart)/86400/365,1) as Age
		,cm.RaceID
		,cm.CommandID
		--,*
	FROM
		vw_const as c
	inner join FCT_Commander as cm on cm.RaceID = c.RaceID and cm.CommanderType = 3
	inner join FCT_CommanderBonuses as bnLabs on bnLabs.CommanderID = cm.CommanderID and bnLabs.BonusID = 27	-- number of labs
	left join FCT_CommanderBonuses as bnBonus on bnBonus.CommanderID = cm.CommanderID and bnBonus.BonusID = 3	-- research bonus (raw multiplier)
)

SELECT
	cm.Name
	, drf.FieldName
	, ts.Name
	, cm.Labs
	, cm.BonusValue
	, cm.Age
	, rp.*
FROM
	FCT_ResearchProject as rp 
inner join vw_const as v on v.RaceID = rp.RaceID
inner join DIM_ResearchField as drf on drf.ResearchFieldID = rp.ResSpecID
inner join CTE_Commanders as cm on cm.RaceID = rp.RaceID and cm.CommandID = rp.ProjectID
inner join FCT_TechSystem as ts on ts.TechSystemID = rp.TechID
order by
	drf.FieldName
	,cm.Labs desc
	,cm.BonusValue desc
	,cm.Age
